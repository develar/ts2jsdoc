import * as ts from "typescript";
import * as path from "path";
import {emptyDir, readJson, writeFile} from "fs-extra-p";
import {JsDocRenderer} from "./JsDocRenderer";
import {checkErrors} from "./util";

export async function generateAndWrite(basePath: string, config: ts.ParsedCommandLine, tsConfig: any) {
  let packageData: any = {name: "packageJsonNotDefined"}
  try {
    packageData = await readJson(path.join(basePath, "package.json"))
  }
  catch (e) {
  }

  const generator = generate(basePath, config, tsConfig, packageData.name, packageData == null ? null : packageData.main)

  const out = path.resolve(basePath, tsConfig.jsdoc)
  console.log(`Generating JSDoc to ${out}`)
  await emptyDir(out)

  for (const [moduleId, contents] of generator.moduleNameToResult.entries()) {
    await writeFile(path.join(out, moduleId.replace(/\//g, "-") + ".js"), `/** 
 * @module ${moduleId}
 */

${contents.join("\n\n")}`)
  }
}

export function generate(basePath: string, config: ts.ParsedCommandLine, tsConfig: any, moduleName: string, main: string | null): JsDocGenerator {
  const compilerOptions = config.options
  const compilerHost = ts.createCompilerHost(compilerOptions)
  const program = ts.createProgram(config.fileNames, compilerOptions, compilerHost)
  checkErrors(ts.getPreEmitDiagnostics(program))

  const compilerOutDir = compilerOptions.outDir
  if (compilerOutDir == null) {
    throw new Error("outDir is not specified in the compilerOptions")
  }

  const generator = new JsDocGenerator(program, path.relative(basePath, compilerOptions.outDir), moduleName, main, (<any>program).getCommonSourceDirectory())
  generateJsDoc(generator, path.resolve(basePath, tsConfig.jsdoc))
  return generator
}

function generateJsDoc(generator: JsDocGenerator, out: string): void {
  for (const sourceFile of generator.program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      generator.generate(sourceFile)
    }
  }
}

export class JsDocGenerator {
  private readonly fileNameToModuleId: any = {}
  readonly moduleNameToResult = new Map<string, Array<string>>()


  private currentSourceModuleId: string
  private currentSourceFile: ts.SourceFile
  private readonly renderer = new JsDocRenderer(this)

  constructor(readonly program: ts.Program, readonly relativeOutDir: string, private readonly moduleName: string, private readonly mainFile: string, private readonly commonSourceDirectory: string) {
  }

  private sourceFileToModuleId(sourceFile: ts.SourceFile) {
    if (sourceFile.isDeclarationFile) {
      if (sourceFile.fileName.endsWith("node.d.ts")) {
        return {sourceModuleId: "node", fileNameWithoutExt: ""}
      }
    }

    let sourceModuleId: string
    const fileNameWithoutExt = sourceFile.fileName.slice(0, sourceFile.fileName.lastIndexOf(".")).replace(/\\/g, "/")
    const name = path.relative(this.commonSourceDirectory, fileNameWithoutExt)
    if (this.moduleName != null) {
      sourceModuleId = this.moduleName
      if (name !== "index") {
        sourceModuleId += '/' + this.relativeOutDir
      }
    }
    else {
      sourceModuleId = this.relativeOutDir
    }

    if (name !== "index") {
      sourceModuleId += '/' + name
    }

    if (this.mainFile == null ? fileNameWithoutExt.endsWith("/main") : `${fileNameWithoutExt}.js`.includes(path.posix.relative(this.relativeOutDir, this.mainFile))) {
      sourceModuleId = this.moduleName
    }
    return {sourceModuleId, fileNameWithoutExt}
  }

  generate(sourceFile: ts.SourceFile) {
    if (sourceFile.text.length === 0) {
      return
    }

    this.currentSourceFile = sourceFile
    this.renderer.currentSourceFile = sourceFile

    const {sourceModuleId, fileNameWithoutExt} = this.sourceFileToModuleId(sourceFile)
    this.currentSourceModuleId = sourceModuleId
    this.fileNameToModuleId[path.resolve(fileNameWithoutExt).replace(/\\/g, "/")] = sourceModuleId

    const content = processTree(sourceFile, (node) => {
      if (node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.ClassDeclaration) {
        return this.renderClassOrInterface(node)
      }
      else if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
        this.renderer.indent = ""
        return this.renderFunction(<ts.FunctionDeclaration>node)
      }
      else if (node.kind === ts.SyntaxKind.ExportKeyword) {
        return ""
      }
      else if (node.kind === ts.SyntaxKind.SourceFile) {
        return null
      }
      else if (node.kind === ts.SyntaxKind.VariableStatement) {
        return this.renderVariableStatement(<ts.VariableStatement>node)
      }
      return ""
    })

    let contents = this.moduleNameToResult.get(sourceModuleId)
    if (contents == null) {
      contents = []
      this.moduleNameToResult.set(sourceModuleId, contents)
    }
    contents.push(content)
  }

  getTypeNamePathByNode(node: ts.Node): string | null {
    if (node.kind === ts.SyntaxKind.UnionType) {
      const typeNames: Array<string> = []
      for (const type of (<ts.UnionType>(<any>node)).types) {
        const name = this.getTypeNamePathByNode(<any>type)
        if (name == null) {
          throw new Error("cannot get name for " + node.getText(node.getSourceFile()))
        }
        typeNames.push(name)
      }
      return typeNames.join(" | ")
    }
    else if (node.kind === ts.SyntaxKind.FunctionType) {
      return "callback"
    }
    else if (node.kind === ts.SyntaxKind.NumberKeyword) {
      return "number"
    }
    else if (node.kind === ts.SyntaxKind.StringKeyword) {
      return "string"
    }
    else if (node.kind === ts.SyntaxKind.BooleanKeyword) {
      return "boolean"
    }
    else if (node.kind === ts.SyntaxKind.NullKeyword) {
      return "null"
    }
    else if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
      return "undefined"
    }
    else if (node.kind === ts.SyntaxKind.LiteralType) {
      const text = (<ts.LiteralLikeNode>(<any>(<ts.LiteralTypeNode>node).literal)).text
      return `"${text}"`
    }

    const type = this.program.getTypeChecker().getTypeAtLocation(node)
    return type == null ? null : this.getTypeNamePath(type)
  }

  getTypeNamePath(type: ts.Type): string | null {
    if (type.flags & ts.TypeFlags.Boolean) {
      return "boolean"
    }
    if (type.flags & ts.TypeFlags.Void) {
      return "void"
    }
    if (type.flags & ts.TypeFlags.Null) {
      return "null"
    }
    if (type.flags & ts.TypeFlags.String) {
      return "string"
    }
    if (type.flags & ts.TypeFlags.Number) {
      return "number"
    }
    if (type.flags & ts.TypeFlags.Undefined) {
      return "undefined"
    }

    const symbol = type.symbol
    if (symbol == null || symbol.declarations == null || symbol.declarations.length === 0) {
      return null
    }

    const valueDeclaration = symbol.valueDeclaration || ((symbol.declarations == null || symbol.declarations.length === 0) ? null : symbol.declarations[0])
    if (ts.getCombinedModifierFlags(valueDeclaration) & ts.ModifierFlags.Ambient) {
      // Error from lib.es5.d.ts
      return symbol.name
    }

    let typeSourceParent: ts.Node = valueDeclaration
    while (typeSourceParent != null) {
      if (typeSourceParent.kind === ts.SyntaxKind.ModuleDeclaration && (typeSourceParent.flags & ts.NodeFlags.NestedNamespace) <= 0) {
        const m = <ts.ModuleDeclaration>typeSourceParent
        const sourceModuleId = (<ts.Identifier>m.name).text
        if (typeSourceParent.flags & ts.NodeFlags.Namespace) {
          return `${sourceModuleId}:${symbol.name}`
        }
        else {
          return `module:${sourceModuleId}.${symbol.name}`
        }
      }
      else if (typeSourceParent.kind === ts.SyntaxKind.SourceFile) {
        const sourceModuleId = this.sourceFileToModuleId(<ts.SourceFile>typeSourceParent).sourceModuleId
        return `module:${sourceModuleId}.${symbol.name}`
      }

      typeSourceParent = typeSourceParent.parent
    }

    console.warn(`Cannot find parent for ${symbol}`)
    return null
  }

  // transform:
  // export const autoUpdater: AppUpdater = impl
  private renderVariableStatement(node: ts.VariableStatement): string {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return ""
    }

    const declarations = node.declarationList == null ? null : node.declarationList.declarations
    if (declarations == null && declarations.length !== 1) {
      return ""
    }

    const declaration = <ts.VariableDeclaration>declarations[0]
    if (declaration.type == null) {
      return ""
    }

    this.renderer.indent = ""

    let typeName
    const type = this.program.getTypeChecker().getTypeAtLocation(declaration)
    if (type.symbol != null && type.symbol.valueDeclaration != null) {
      typeName = this.getTypeNamePath(type)
    }
    else {
      typeName = (<ts.Identifier>(<ts.TypeReferenceNode>declaration.type).typeName).text
    }

    const tags = [`@type ${typeName}`]

    // NodeFlags.Const on VariableDeclarationList, not on VariableDeclaration
    if (node.declarationList.flags & ts.NodeFlags.Const) {
      tags.push("@constant")
    }

    let result = this.renderer.formatComment(declaration, tags)
    // jsdoc cannot parse const, so, we always use var
    result += `${this.renderer.indent}export var ${(<ts.Identifier>declaration.name).text}\n`
    return result
  }

  private renderFunction(node: ts.FunctionDeclaration): string {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return ""
    }

    const name = (<ts.Identifier>node.name).text
    // return `export function ${name}() {}`
    return this.renderer.renderMethod({name: name, node: node, tags: []})
  }

  private renderClassOrInterface(node: ts.Node): string {
    this.renderer.indent = ""

    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return ""
    }

    const nodeDeclaration = <ts.InterfaceDeclaration>node
    const className = (<ts.Identifier>nodeDeclaration.name).text

    let result = "/** \n"
    result += this.renderer.description(node)

    if (node.kind === ts.SyntaxKind.InterfaceDeclaration) {
      result += ` * @interface ${this.computeTypePath()}.${className}\n`
    }

    const clazz = <ts.ClassDeclaration>node
    if (clazz.heritageClauses != null) {
      for (const heritageClause of clazz.heritageClauses) {
        if (heritageClause.types != null) {
          for (const type of heritageClause.types) {
            const typeNamePath = this.getTypeNamePathByNode(type)
            if (typeNamePath != null) {
              result += ` * @extends ${typeNamePath}\n`
            }
          }
        }
      }
    }

    this.renderer.indent = "  "
    const methods: Array<MethodDescriptor> = []
    const properties: Array<Property> = []
    for (const member of nodeDeclaration.members) {
      if (member.kind === ts.SyntaxKind.PropertySignature) {
        const p = this.describeProperty(<any>member)
        if (p != null) {
          properties.push(p)
        }
      }
      else if (member.kind === ts.SyntaxKind.MethodDeclaration || member.kind === ts.SyntaxKind.MethodSignature) {
        const m = this.renderMethod(<any>member, className)
        if (m != null) {
          methods.push(m)
        }
      }
    }

    result += this.renderer.renderProperties(properties)

    result += " */\n"
    result += `export class ${className} {\n`

    methods.sort((a, b) => {
      let weightA = a.isProtected ? 100 : 0
      let weightB = b.isProtected ? 100 : 0

      // do not reorder getFeedURL/setFeedURL
      weightA += trimMutatorPrefix(a.name).localeCompare(trimMutatorPrefix(b.name))
      return weightA - weightB
    })

    for (const method of methods) {
      result += this.renderer.renderMethod(method)
      if (method !== methods[methods.length - 1]) {
        result += "\n"
      }
    }

    result += "}\n\n"
    return result
  }

  private describeProperty(node: ts.SignatureDeclaration): Property | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }

    const name = (<ts.Identifier>node.name).text
    return {name, types: this.getTypeNamePathByNode(node.type), node}
  }

  private renderMethod(node: ts.SignatureDeclaration, className: string): MethodDescriptor | null {
    // node.flags doesn't report correctly for private methods
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }

    const tags = []

    const isProtected = (flags & ts.ModifierFlags.Protected) > 0
    if (isProtected) {
      tags.push(`@protected`)
    }

    const name = (<ts.Identifier>node.name).text
    // https://github.com/jsdoc3/jsdoc/issues/1137#issuecomment-281257286
    tags.push(`@function ${this.computeTypePath()}.${className}#${name}`)

    return {name, tags, isProtected, node}
  }

  private computeTypePath(): string {
    return "module:" + this.currentSourceModuleId
  }
}

export function processTree(sourceFile: ts.SourceFile, replacer: (node: ts.Node) => string): string {
  let code = '';
  let cursorPosition = 0;

  function skip(node: ts.Node) {
    cursorPosition = node.end;
  }

  function readThrough(node: ts.Node) {
    code += sourceFile.text.slice(cursorPosition, node.pos);
    cursorPosition = node.pos;
  }

  function visit(node: ts.Node) {
    readThrough(node);

    if (node.flags & ts.ModifierFlags.Private) {
      // skip private nodes
      skip(node)
      return
    }

    if (node.kind === ts.SyntaxKind.ImportDeclaration && (<ts.ImportDeclaration>node).importClause == null) {
      // ignore side effects only imports (like import "source-map-support/register")
      skip(node)
      return
    }

    const replacement = replacer(node)
    if (replacement != null) {
      code += replacement
      skip(node)
    }
    else {
      if (node.kind === ts.SyntaxKind.ClassDeclaration || node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.FunctionDeclaration) {
        code += "\n"
      }
      ts.forEachChild(node, visit)
    }
  }

  visit(sourceFile)
  code += sourceFile.text.slice(cursorPosition)

  return code
}

export interface MethodDescriptor {
  name: string
  tags: Array<string>

  isProtected?: boolean

  node: ts.SignatureDeclaration
}

export interface Property {
  name: string
  types: string

  node: ts.SignatureDeclaration
}

function trimMutatorPrefix(name: string) {
  if (name.length > 4 && name[3] === name[3].toUpperCase() && (name.startsWith("get") || name.startsWith("set"))) {
    return name[3].toLowerCase() + name.substring(4)
  }
  return name
}