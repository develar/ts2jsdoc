import * as ts from "typescript"
import * as path from "path"
import { JsDocRenderer } from "./JsDocRenderer"
import { checkErrors, processTree } from "./util"
import { Class, Descriptor, MethodDescriptor, Property, SourceFileDescriptor, SourceFileModuleInfo, Type, Variable } from "./psi"
import { Annotation, parse as parseJsDoc } from "doctrine"

export interface TsToJsdocOptions {
  readonly out: string
  readonly externalIfNotMain?: string | null
  readonly access?: string | null

  /**
   * The path to examples dir.
   */
  readonly examples?: string | null
}

const vm = require("vm")

export type ModulePathMapper = (oldPath: string) => string

export function generate(basePath: string, config: ts.ParsedCommandLine, moduleName: string, main: string | null, options: TsToJsdocOptions): JsDocGenerator {
  const compilerOptions = config.options
  const compilerHost = ts.createCompilerHost(compilerOptions)
  const program = ts.createProgram(config.fileNames, compilerOptions, compilerHost)
  checkErrors(ts.getPreEmitDiagnostics(program))

  const compilerOutDir = compilerOptions.outDir
  if (compilerOutDir == null) {
    throw new Error("outDir is not specified in the compilerOptions")
  }

  const generator = new JsDocGenerator(program, path.relative(basePath, compilerOutDir), moduleName, main, (<any>program).getCommonSourceDirectory(), options, compilerOptions.baseUrl)
  for (const sourceFile of program.getSourceFiles()) {
    if (!sourceFile.isDeclarationFile) {
      generator.generate(sourceFile)
    }
  }
  return generator
}

export class JsDocGenerator {
  readonly moduleNameToResult = new Map<string, SourceFileDescriptor>()

  private currentSourceModuleId: string
  readonly renderer = new JsDocRenderer(this)

  readonly mainMappings = new Map<string, Array<string>>()

  constructor(readonly program: ts.Program, readonly relativeOutDir: string, readonly moduleName: string | null, private readonly mainFile: string | null, private readonly commonSourceDirectory: string, private readonly options: TsToJsdocOptions, private readonly baseUrl?: string) {
  }

  private sourceFileToModuleId(sourceFile: ts.SourceFile): SourceFileModuleInfo {
    if (sourceFile.isDeclarationFile) {
      if (sourceFile.fileName.endsWith("node.d.ts")) {
        return {id: "node", isMain: false}
      }

      let fileNameWithoutExt = sourceFile.fileName.slice(0, sourceFile.fileName.length - ".d.ts".length).replace(/\\/g, "/")
      if (this.baseUrl != null && fileNameWithoutExt.startsWith(this.baseUrl)) {
        fileNameWithoutExt = fileNameWithoutExt.substring(this.baseUrl.length + 1)
      }
      return {id: fileNameWithoutExt, isMain: false}
    }

    let sourceModuleId: string
    const fileNameWithoutExt = sourceFile.fileName.slice(0, sourceFile.fileName.lastIndexOf(".")).replace(/\\/g, "/")
    const name = path.relative(this.commonSourceDirectory, fileNameWithoutExt)
    if (this.moduleName != null) {
      sourceModuleId = this.moduleName
      if (name !== "index") {
        sourceModuleId += "/" + this.relativeOutDir
      }
    }
    else {
      sourceModuleId = this.relativeOutDir
    }

    if (name !== "index") {
      sourceModuleId += "/" + name
    }

    const isMain = this.mainFile == null ? fileNameWithoutExt.endsWith("/main") : `${fileNameWithoutExt}.js`.includes(path.posix.relative(this.relativeOutDir, this.mainFile))
    if (isMain) {
      sourceModuleId = this.moduleName!!
    }
    return {id: sourceModuleId, isMain}
  }

  generate(sourceFile: ts.SourceFile): void {
    if (sourceFile.text.length === 0) {
      return
    }

    const moduleId = this.sourceFileToModuleId(sourceFile)
    this.currentSourceModuleId = moduleId.id

    const classes: Array<Class> = []
    const functions: Array<MethodDescriptor> = []
    const members: Array<Variable | Descriptor> = []

    processTree(sourceFile, (node) => {
      if (node.kind === ts.SyntaxKind.InterfaceDeclaration || node.kind === ts.SyntaxKind.ClassDeclaration) {
        const descriptor = this.processClassOrInterface(node)
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
      else if (moduleId.isMain && node.kind === ts.SyntaxKind.ExportDeclaration) {
        this.handleExportFromMain(<ts.ExportDeclaration>node)
        return true
      }
      else if (node.kind === ts.SyntaxKind.SourceFile) {
        return false
      }
      else if (node.kind === ts.SyntaxKind.VariableStatement) {
        const descriptor = this.describeVariable(<ts.VariableStatement>node)
        if (descriptor != null) {
          members.push(descriptor)
        }
      }
      else if (node.kind === ts.SyntaxKind.EnumDeclaration) {
        const descriptor = this.describeEnum(<ts.EnumDeclaration>node)
        if (descriptor != null) {
          members.push(descriptor)
        }
      }
      return true
    })

    const existingPsi = this.moduleNameToResult.get(moduleId.id)
    if (existingPsi == null) {
      this.moduleNameToResult.set(moduleId.id, {classes, functions, members})
    }
    else {
      existingPsi.classes.push(...classes)
      existingPsi.functions.push(...functions)
      existingPsi.members.push(...members)
    }
  }

  private handleExportFromMain(node: ts.ExportDeclaration) {
    const moduleSpecifier = node.moduleSpecifier
    const exportClause = node.exportClause
    if (exportClause == null || moduleSpecifier == null) {
      return
    }

    if (moduleSpecifier.kind !== ts.SyntaxKind.StringLiteral) {
      return
    }

    const filePath = (<ts.StringLiteral>moduleSpecifier).text
    if (!filePath.startsWith(".")) {
      return
    }

    const fullFilename = path.posix.resolve(path.posix.dirname(node.getSourceFile().fileName), filePath) + ".ts"
    const sourceFile = this.program.getSourceFile(fullFilename)
    if (sourceFile == null) {
      return
    }

    const names: Array<string> = []
    for (const e of exportClause.elements) {
      if (e.kind === ts.SyntaxKind.ExportSpecifier) {
        names.push((<ts.Identifier>(<ts.ExportSpecifier>e).name).text)
      }
      else {
        console.error(`Unsupported export element: ${e.getText(e.getSourceFile())}`)
      }
    }

    this.mainMappings.set(this.sourceFileToModuleId(sourceFile).id, names)
  }

  getTypeNamePathByNode(node: ts.Node): Array<string | Type> | null {
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
    else if (node.kind === ts.SyntaxKind.TypeLiteral) {
      // todo
      return ['Object.<string, any>']
    }

    const type = this.program.getTypeChecker().getTypeAtLocation(node)
    return type == null ? null : this.getTypeNames(type, node)
  }

  private typesToList(types: Array<ts.Type>, node: ts.Node) {
    const typeNames: Array<string | Type> = []
    for (const type of types) {
      if ((<any>type).kind == null) {
        const name = this.getTypeNamePath(<any>type)
        if (name == null) {
          throw new Error(`Cannot get name for ${node.getText(node.getSourceFile())}`)
        }
        typeNames.push(name)
      }
      else {
        const name = this.getTypeNamePathByNode(<any>type)
        if (name == null) {
          throw new Error(`Cannot get name for ${node.getText(node.getSourceFile())}`)
        }
        typeNames.push(...name)
      }
    }
    return typeNames
  }

  getTypeNames(type: ts.Type, node: ts.Node): Array<string | Type> | null {
    if (type.flags & ts.TypeFlags.UnionOrIntersection && !(type.flags & ts.TypeFlags.Enum) && !(type.flags & ts.TypeFlags.EnumLiteral) && !(type.flags & ts.TypeFlags.Boolean) && !(type.flags & ts.TypeFlags.BooleanLiteral)) {
      return this.typesToList((<ts.UnionOrIntersectionType>type).types, node)
    }

    let result = this.getTypeNamePath(type)
    if (result == null) {
      throw new Error("Cannot infer getTypeNamePath")
    }

    const typeArguments = (<ts.TypeReference>type).typeArguments
    if (typeArguments != null) {
      const subTypes = []
      for (const type of typeArguments) {
        subTypes.push(...this.getTypeNames(type, node)!!)
      }
      return [{name: result, subTypes: subTypes}]
    }
    return [result]
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
    if (type.flags & ts.TypeFlags.Any) {
      return "any"
    }
    if (type.flags & ts.TypeFlags.Literal) {
      return `"${(<ts.LiteralType>type).value}"`
    }

    const symbol = type.symbol
    if (symbol == null || symbol.declarations == null || symbol.declarations.length === 0) {
      return null
    }

    const valueDeclaration = (symbol.valueDeclaration || ((symbol.declarations == null || symbol.declarations.length === 0) ? null : symbol.declarations[0]))!!
    if (ts.getCombinedModifierFlags(valueDeclaration) & ts.ModifierFlags.Ambient) {
      // Error from lib.es5.d.ts
      return symbol.name
    }

    let typeSourceParent: ts.Node | null | undefined = valueDeclaration
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
        const sourceModuleId = this.sourceFileToModuleId(<ts.SourceFile>typeSourceParent).id
        return `module:${sourceModuleId}.${symbol.name}`
      }

      typeSourceParent = typeSourceParent.parent
    }

    console.warn(`Cannot find parent for ${symbol}`)
    return null
  }

  private describeEnum(node: ts.EnumDeclaration): Descriptor | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const type = {
      names: ["number"]
    }

    const name = (<ts.Identifier>node.name).text
    const moduleId = this.computeTypePath()
    const id = `${moduleId}.${name}`

    const properties: Array<Descriptor> = []
    for (const member of node.members) {
      const name = (<ts.Identifier>member.name).text
      properties.push({
        name: name,
        kind: "member",
        scope: "static",
        memberof: id,
        type: type,
      })
    }

    // we don't set readonly because it is clear that enum is not mutable
    // e.g. jsdoc2md wil add useless "Read only: true"
    return {
      node: node,
      id: id,
      name: name,
      longname: id,
      kind: "enum",
      scope: "static",
      memberof: moduleId,
      type: type,
      properties: properties,
    }
  }

  private describeVariable(node: ts.VariableStatement): Variable | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const declarations = node.declarationList == null ? null : node.declarationList.declarations
    if (declarations == null || declarations.length !== 1) {
      return null
    }

    const declaration = <ts.VariableDeclaration>declarations[0]
    if (declaration.type == null) {
      return null
    }

    const existingJsDoc = JsDocRenderer.getComment(node)
    const jsDoc = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
    if (JsDocGenerator.isHidden(jsDoc)) {
      return null
    }

    let types
    const type = this.program.getTypeChecker().getTypeAtLocation(declaration)
    if (type.symbol != null && type.symbol.valueDeclaration != null) {
      types = [this.getTypeNamePath(type)!!]
    }
    else {
      types = this.getTypeNamePathByNode(declaration.type)!!
    }

    // NodeFlags.Const on VariableDeclarationList, not on VariableDeclaration
    return {types, node, name: (<ts.Identifier>declaration.name).text, isConst: (node.declarationList.flags & ts.NodeFlags.Const) > 0}
  }

  //noinspection JSMethodCanBeStatic
  private describeFunction(node: ts.FunctionDeclaration): MethodDescriptor | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const existingJsDoc = JsDocRenderer.getComment(node)
    const jsDoc = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
    return JsDocGenerator.isHidden(jsDoc) ? null : {name: (node.name as ts.Identifier).text, node: node, tags: [], jsDoc }
  }

  private static isHidden(jsDoc: Annotation | null): boolean {
    if (jsDoc == null) {
      return false
    }

    for (const tag of jsDoc.tags) {
      if (tag.title === "internal" || tag.title === "private") {
        return true
      }
    }
    return false
  }

  private processClassOrInterface(node: ts.Node): Class | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (!(flags & ts.ModifierFlags.Export)) {
      return null
    }

    const nodeDeclaration = <ts.InterfaceDeclaration>node

    const existingJsDoc = JsDocRenderer.getComment(node)
    const jsDoc = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
    if (JsDocGenerator.isHidden(jsDoc)) {
      return null
    }

    const className = (<ts.Identifier>nodeDeclaration.name).text

    const clazz = <ts.ClassDeclaration>node
    let parents: Array<string | Type> = []
    if (clazz.heritageClauses != null) {
      for (const heritageClause of clazz.heritageClauses) {
        if (heritageClause.types != null) {
          for (const type of heritageClause.types) {
            const typeNamePath = this.getTypeNamePathByNode(type)
            if (typeNamePath != null) {
              parents = parents.concat(typeNamePath)
            }
          }
        }
      }
    }

    const methods: Array<MethodDescriptor> = []
    const properties: Array<Property> = []
    for (const member of nodeDeclaration.members) {
      if (member.kind === ts.SyntaxKind.PropertySignature) {
        const p = this.describeProperty(<any>member, node.kind === ts.SyntaxKind.ClassDeclaration)
        if (p != null) {
          properties.push(p)
        }
      }
      else if (member.kind === ts.SyntaxKind.PropertyDeclaration) {
        const p = this.describeProperty(<any>member, node.kind === ts.SyntaxKind.ClassDeclaration)
        if (p != null) {
          properties.push(p)
        }
      }
      else if (member.kind === ts.SyntaxKind.GetAccessor) {
        const p = this.describeProperty(<any>member, node.kind === ts.SyntaxKind.ClassDeclaration)
        if (p != null) {
          properties.push(p)
        }
      }
      else if (member.kind === ts.SyntaxKind.MethodDeclaration || member.kind === ts.SyntaxKind.MethodSignature) {
        const m = this.renderMethod(<any>member)
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

  private describeProperty(node: ts.PropertySignature | ts.PropertyDeclaration, isParentClass: boolean): Property | null {
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }
    if (this.options.access === "public" && flags & ts.ModifierFlags.Protected) {
      return null
    }

    const name = (<ts.Identifier>node.name).text

    let types: Array<string | Type>
    if (node.type == null) {
      const type = this.program.getTypeChecker().getTypeAtLocation(node)
      if (type == null) {
        return null
      }
      types = this.getTypeNames(type, node)!!
    }
    else {
      types = this.getTypeNamePathByNode(node.type)!!
    }

    let isOptional = node.questionToken != null
    let defaultValue = null
    const initializer = node.initializer
    if (initializer != null) {
      if ((<any>initializer).expression != null || (<ts.Node>initializer).kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
        defaultValue = initializer.getText()
      }
      else {
        try {
          const sandbox = {sandboxVar: null as any}
          vm.runInNewContext(`sandboxVar=${initializer.getText()}`, sandbox)

          const val = sandbox.sandboxVar
          if (val === null || typeof val === "string" || typeof val === "number" || "boolean" || Object.prototype.toString.call(val) === "[object Array]") {
            defaultValue = val
          }
          else if (val) {
            console.warn(`unknown initializer for property ${name}: ${val}`)
          }
        }
        catch (e) {
          console.info(`exception evaluating initializer for property ${name}`)
          defaultValue = initializer.getText()
        }
      }
    }

    isOptional = isOptional || defaultValue != null || types!.includes("null")
    if (!isOptional && isParentClass && (flags & ts.ModifierFlags.Readonly) > 0) {
      isOptional = true
    }
    return {name, types, node, isOptional, defaultValue}
  }

  private renderMethod(node: ts.SignatureDeclaration): MethodDescriptor | null {
    // node.flags doesn't report correctly for private methods
    const flags = ts.getCombinedModifierFlags(node)
    if (flags & ts.ModifierFlags.Private) {
      return null
    }
    if (this.options.access === "public" && flags & ts.ModifierFlags.Protected) {
      return null
    }

    const tags = []

    const isProtected = (flags & ts.ModifierFlags.Protected) > 0
    if (isProtected) {
      tags.push(`@protected`)
    }

    const name = (<ts.Identifier>node.name).text
    const existingJsDoc = JsDocRenderer.getComment(node)
    const jsDoc = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
    return JsDocGenerator.isHidden(jsDoc) ? null : {name, tags, isProtected, node, jsDoc}
  }

  private computeTypePath(): string {
    return `module:${this.currentSourceModuleId}`
  }
}

function trimMutatorPrefix(name: string) {
  if (name.length > 4 && name[3] === name[3].toUpperCase() && (name.startsWith("get") || name.startsWith("set"))) {
    return name[3].toLowerCase() + name.substring(4)
  }
  return name
}

export interface Example {
  name: string
  content: string
  lang: string
}