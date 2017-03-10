import * as ts from "typescript"
import { JsDocGenerator } from "./JsDocGenerator"
import { parse as parseJsDoc, Tag } from "doctrine"
import { Class, MethodDescriptor, Property, Variable } from "./psi"

export class JsDocRenderer {
  indent: string = ""

  constructor(private readonly generator: JsDocGenerator) {
  }

  normalizeDescription(comment: string) {
    return this.indent + " * " + comment
      .split("\n")
      .map(it => it.trim())
      .filter(it => it != "*/" && it.length > 0)
      .join(`\n${this.indent} * `)
  }

  formatComment(node: ts.Node, tags: Array<string>, description?: string): string {
    const indent = this.indent

    let result = `${indent}/**\n`

    if (description == null) {
      const comment = JsDocRenderer.getComment(node)
      if (comment != null) {
        result += `${this.normalizeDescription(comment)}\n`
      }
    }
    else if (description.length > 0) {
      result += `${indent} * ${description}\n`
    }

    // must be added after user description
    if (tags.length > 0) {
      for (const tag of tags) {
        result += `${indent} * ${tag}\n`
      }
    }

    result += `${indent} */\n`
    return result
  }

  renderClassOrInterface(descriptor: Class, oldModulePathToNew: Map<string, string>): string {
    this.indent = ""

    const tags: Array<string> = []

    if (descriptor.isInterface) {
      tags.push(`@interface ${descriptor.modulePath}.${descriptor.name}`)
    }

    for (const parent of descriptor.parents) {
      tags.push(`@extends ${oldModulePathToNew.get(parent) || parent}`)
    }

    JsDocRenderer.renderProperties(descriptor.properties, tags, oldModulePathToNew)

    let result = this.formatComment(descriptor.node, tags, parseExistingJsDoc(descriptor.node, tags) || "")
    result += `export class ${descriptor.name} {\n`

    for (const method of descriptor.methods) {
      result += this.renderMethod(method, oldModulePathToNew)
      if (method !== descriptor.methods[descriptor.methods.length - 1]) {
        result += "\n"
      }
    }

    result += "}\n\n"
    return result
  }

  renderMethod(method: MethodDescriptor, oldModulePathToNew: Map<string, string>): string {
    const tags = method.tags.slice()

    const paramNameToInfo = new Map<string, Tag>()
    let returns: Tag | null

    const existingJsDoc = JsDocRenderer.getComment(method.node)
    const parsed = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
    if (parsed != null) {
      for (const tag of parsed.tags) {
        if (tag.title === "param") {
          if (tag.name != null) {
            paramNameToInfo.set(tag.name, tag)
          }
        }
        else if (tag.title === "returns" || tag.title === "return") {
          returns = tag
        }
        else {
          tags.push(`@${tag.title} ${tag.description}`)
        }
      }
    }

    for (const param of method.node.parameters) {
      let name = (<ts.Identifier>param.name).text
      let text = `@param`

      const type = param.type
      if (type != null) {
        text += ` ${renderTypes(this.generator.getTypeNamePathByNode(type), oldModulePathToNew)}`
      }

      const tag = paramNameToInfo.get(name)
      text += ` ${name}`
      if (tag != null) {
        text += ` ${tag.description}`
      }
      tags.push(text)
    }

    const signature = this.generator.program.getTypeChecker().getSignatureFromDeclaration(method.node)
    const returnType = this.generator.getTypeNamePath(signature.getReturnType())
    // http://stackoverflow.com/questions/4759175/how-to-return-void-in-jsdoc
    if (returnType !== "void") {
      let text = `@returns ${renderTypes([returnType])}`
      if (returns != null) {
        text += ` ${returns.description}`
      }
      tags.push(text)
    }

    let result = this.formatComment(method.node, tags, (parsed == null ? "" : parsed.description) || "")
    result += `${this.indent}`
    if (method.node.kind === ts.SyntaxKind.FunctionDeclaration) {
      result += "export function "
    }
    result += `${method.name}() {}\n`
    return result
  }

  static getComment(node: ts.Node): string | null {
    const sourceFile = node.getSourceFile()
    const leadingCommentRanges = ts.getLeadingCommentRanges(sourceFile.text, node.pos)
    if (leadingCommentRanges == null || leadingCommentRanges.length === 0) {
      return null
    }

    const commentRange = leadingCommentRanges[0]
    if (sourceFile.text[commentRange.pos] === "/" && sourceFile.text[commentRange.pos + 1] === "*" && sourceFile.text[commentRange.pos + 2] == "*") {
      return sourceFile.text.slice(commentRange.pos + 3, commentRange.end).trim()
    }
    return null
  }

  renderVariable(descriptor: Variable): string {
    this.indent = ""

    const tags = [`@type ${renderTypes(descriptor.types)}`]

    if (descriptor.isConst) {
      tags.push("@constant")
    }

    let result = this.formatComment(descriptor.node, tags)
    // jsdoc cannot parse const, so, we always use var
    result += `export var ${descriptor.name}\n`
    return result
  }

  // form http://stackoverflow.com/questions/10490713/how-to-document-the-properties-of-the-object-in-the-jsdoc-3-tag-this
  // doesn't produce properties table, so, we use property tags
  private static renderProperties(properties: Array<Property>, tags: Array<string>, oldModulePathToNew: Map<string, string>): void {
    for (const descriptor of properties) {
      const existingJsDoc = JsDocRenderer.getComment(descriptor.node)
      const parsed = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
      let defaultValue = null
      if (parsed != null) {
        for (const tag of parsed.tags) {
          if (tag.title === "default") {
            defaultValue = tag.description
          }
          else {
            tags.push(`@${tag.title} ${tag.description}`)
          }
        }
      }

      let result = `@property ${renderTypes(descriptor.types, oldModulePathToNew)} `

      if (descriptor.isOptional) {
        result += "["
      }
      result += descriptor.name

      if (defaultValue != null) {
        result += `=${defaultValue}`
      }

      if (descriptor.isOptional) {
        result += "]"
      }

      const description = parsed == null ? null : parsed.description
      if (description != null) {
        result += ` ${parseJsDoc(description, {unwrap: true}).description}`
      }
      tags.push(result)
    }
  }
}

function parseExistingJsDoc(node: ts.Node, tags: Array<string>): string | null {
  const existingJsDoc = JsDocRenderer.getComment(node)
  const parsed = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
  if (parsed != null) {
    for (const tag of parsed.tags) {
      tags.push(`@${tag.title} ${tag.description}`)
    }
  }

  return parsed == null ? null : parsed.description
}

function renderTypes(names: Array<string>, oldModulePathToNew?: Map<string, string>) {
  if (oldModulePathToNew != null) {
    names = names.map(it => oldModulePathToNew.get(it) || it)
  }
  return `{${names.join(" | ")}}`
}