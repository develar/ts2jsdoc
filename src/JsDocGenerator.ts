import * as ts from "typescript"
import * as path from "path"
import { emptyDir, readJson, writeFile } from "fs-extra-p"
import { JsDocRenderer } from "./JsDocRenderer"
import { checkErrors, processTree } from "./util"
import { Class, MethodDescriptor, Property, SourceFileDescriptor, Variable } from "./psi"

export async function generateAndWrite(basePath: string, config: ts.ParsedCommandLine, tsConfig: any) {
  let packageData: any = {name: "packageJsonNotDefined"}
  try {
    packageData = await readJson(path.join(basePath, "package.json"))
  }
  catch (e) {
  }

  const generator = generate(basePath, config, packageData.name, packageData == null ? null : packageData.main)

  const out = path.resolve(basePath, tsConfig.jsdoc)
  console.log(`Generating JSDoc to ${out}`)
  await emptyDir(out)

  for (const [moduleId, psi] of generator.moduleNameToResult.entries()) {
    let result = ""
    for (const d of psi.variables) {
      result += generator.renderer.renderVariable(d)
    }
    for (const d of psi.classes) {
      result += generator.renderer.renderClassOrInterface(d)
    }
    for (const d of psi.functions) {
      result += generator.renderer.renderMethod(d)
    }

    await writeFile(path.join(out, moduleId.replace(/\//g, "-") + ".js"), `/** 
 * @module ${moduleId}
 */

${result}`)
  }
}

export function generate(basePath: string, config: ts.ParsedCommandLine, moduleName: string, main: string | null): JsDocGenerator {
  const compilerOptions = config.options
  const compilerHost = ts.createCompilerHost(compilerOptions)
  const program = ts.createProgram(config.fileNames, compilerOptions, compilerHost)
  checkErrors(ts.getPreEmitDiagnostics(program))

  const compilerOutDir = compilerOptions.outDir
  if (compilerOutDir == null) {
    throw new Error("outDir is not specified in the compilerOptions")
  }

  const generator = new JsDocGenerator(program, path.relative(basePath, compilerOptions.outDir), moduleName, main, (<any>program).getCommonSourceDirectory())
  generateJsDoc(generator)
  return generator
}

function generateJsDoc(generator: JsDocGenerator): void {
  for (const sourceFile of generator.program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      generator.generate(sourceFile)
    }
  }
}

export class JsDocGenerator {
  private readonly fileNameToModuleId: any = {}
  readonly moduleNameToResult = new Map<string, SourceFileDescriptor>()

  private currentSourceModuleId: string
  readonly renderer = new JsDocRenderer(this)

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

  generate(sourceFile: ts.SourceFile): void {
    if (sourceFile.text.length === 0) {
      return
    }

    const {sourceModuleId, fileNameWithoutExt} = this.sourceFileToModuleId(sourceFile)
    this.currentSourceModuleId = sourceModuleId
    this.fileNameToModuleId[path.resolve(fileNameWithoutExt).replace(/\\/g, "/")] = sourceModuleId

    const classes: Array<Class> = []
    const functions: Array<MethodDescriptor> = []
    const variables: Array<Variable> = []

    processTree(sourceFile, (node) => {
      if (node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.ClassDeclaration) {
        const descriptor = this.renderClassOrInterface(node)
        if (descriptor != null) {
          classes.push(descriptor)
        }
      }
      else if (node.kind === ts.SyntaxKind.FunctionDeclaration) {
        const descriptor = this.describeFunction(<ts.FunctionDeclaration>node)
        if (descriptor != null) {
          functions.push(descriptor)
        }
      }
      else if (node.kind === ts.SyntaxKind.ExportKeyword) {
        return ""
      }
      else if (node.kind === ts.SyntaxKind.SourceFile) {
        return null
      }
      else if (node.kind === ts.SyntaxKind.VariableStatement) {
        const descriptor = this.describeVariable(<ts.VariableStatement>node)
        if (descriptor != null) {
          variables.push(descriptor)
        }
      }
      return ""
    })

    const existingPsi = this.moduleNameToResult.get(sourceModuleId)
    if (existingPsi == null) {
      this.moduleNameToResult.set(sourceModuleId, {classes, functions, variables})
    }
    else {
      existingPsi.classes.push(...classes)
      existingPsi.functions.push(...functions)
      existingPsi.variables.push(...variables)
    }
  }

  getTypeNamePathByNode(node: ts.Node): Array<string> | null {
    if (node.kind === ts.SyntaxKind.UnionType) {
      return this.typesToList((<ts.UnionType>(<any>node)).types, node)
    }
    else if (node.kind === ts.SyntaxKind.FunctionType) {
      return ["callback"]
    }
    else if (node.kind === ts.SyntaxKind.NumberKeyword) {
      return ["number"]
    }
    else if (node.kind === ts.SyntaxKind.StringKeyword) {
      return ["string"]
    }
    else if (node.kind === ts.SyntaxKind.BooleanKeyword) {
      return ["boolean"]
    }
    else if (node.kind === ts.SyntaxKind.NullKeyword) {
      return ["null"]
    }
    else if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
      return ["undefined"]
    }
    else if (node.kind === ts.SyntaxKind.LiteralType) {
      const text = (<ts.LiteralLikeNode>(<any>(<ts.LiteralTypeNode>node).literal)).text
      return [`"${text}"`]
    }

    const type = this.program.getTypeChecker().getTypeAtLocation(node)
    if (type == null) {
      return null
    }

    if (type.flags & ts.TypeFlags.UnionOrIntersection) {
      return this.typesToList((<ts.UnionOrIntersectionType>type).types, node)
    }
    return [this.getTypeNamePath(type)]
  }

  private typesToList(types: Array<ts.Type>, node: ts.Node) {
    const typeNames: Array<string> = []
    for (const type of types) {
      const name = (<any>type).kind == null ? [this.getTypeNamePath(<any>type)] : this.getTypeNamePathByNode(<any>type)
      if (name == null) {
        throw new Error("cannot get name for " + node.getText(node.getSourceFile()))
      }
      typeNames.push(...name)
    }
    return typeNames
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
    if (type.flags & ts.TypeFlags.Literal) {
      return (<ts.LiteralType>type).text
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

  private describeVariable(node: ts.VariableStatement): Variable {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const declarations = node.declarationList == null ? null : node.declarationList.declarations
    if (declarations == null && declarations.length !== 1) {
      return null
    }

    const declaration = <ts.VariableDeclaration>declarations[0]
    if (declaration.type == null) {
      return null
    }

    let typeName
    const type = this.program.getTypeChecker().getTypeAtLocation(declaration)
    if (type.symbol != null && type.symbol.valueDeclaration != null) {
      typeName = this.getTypeNamePath(type)
    }
    else {
      typeName = (<ts.Identifier>(<ts.TypeReferenceNode>declaration.type).typeName).text
    }

    // NodeFlags.Const on VariableDeclarationList, not on VariableDeclaration
    return {typeName, node, name: (<ts.Identifier>declaration.name).text, isConst: (node.declarationList.flags & ts.NodeFlags.Const) > 0}
  }

  //noinspection JSMethodCanBeStatic
  private describeFunction(node: ts.FunctionDeclaration): MethodDescriptor | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }
    return {name: (<ts.Identifier>node.name).text, node: node, tags: []}
  }

  private renderClassOrInterface(node: ts.Node): Class | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const nodeDeclaration = <ts.InterfaceDeclaration>node
    const className = (<ts.Identifier>nodeDeclaration.name).text

    const clazz = <ts.ClassDeclaration>node
    let parents: Array<string> = []
    if (clazz.heritageClauses != null) {
      for (const heritageClause of clazz.heritageClauses) {
        if (heritageClause.types != null) {
          for (const type of heritageClause.types) {
            const typeNamePath = this.getTypeNamePathByNode(type)
            if (typeNamePath != null) {
              parents = typeNamePath
            }
          }
        }
      }
    }

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

    methods.sort((a, b) => {
      let weightA = a.isProtected ? 100 : 0
      let weightB = b.isProtected ? 100 : 0

      // do not reorder getFeedURL/setFeedURL
      weightA += trimMutatorPrefix(a.name).localeCompare(trimMutatorPrefix(b.name))
      return weightA - weightB
    })

    return {
      modulePath: this.computeTypePath(),
      name: className,
      node, methods, properties, parents,
      isInterface: node.kind === ts.SyntaxKind.InterfaceDeclaration
    }
  }

  private describeProperty(node: ts.PropertySignature): Property | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }

    const name = (<ts.Identifier>node.name).text
    return {name, types: this.getTypeNamePathByNode(node.type), node, isOptional: node.questionToken != null}
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

function trimMutatorPrefix(name: string) {
  if (name.length > 4 && name[3] === name[3].toUpperCase() && (name.startsWith("get") || name.startsWith("set"))) {
    return name[3].toLowerCase() + name.substring(4)
  }
  return name
}