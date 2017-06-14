import * as ts from "typescript"
import * as path from "path"
import { Example, JsDocGenerator, ModulePathMapper } from "./JsDocGenerator"
import { parse as parseJsDoc, Tag } from "doctrine"
import { Class, Descriptor, MethodDescriptor, Property, Type, Variable } from "./psi"

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

  normalizeDescription2(comment: string) {
    return this.indent + " * " + comment
      .split("\n")
      .map(it => it.trim())
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
      result += `${this.normalizeDescription2(description)}\n`
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

  renderClassOrInterface(descriptor: Class, modulePathMapper: ModulePathMapper, examples?: Array<Example>): string {
    this.indent = ""

    const tags: Array<string> = []

    if (descriptor.isInterface) {
      tags.push(`@interface ${descriptor.modulePath}.${descriptor.name}`)
    }

    for (const parent of descriptor.parents) {
      // ignore <> type params because JsDoc expects namepath, but not type expression 
      tags.push(`@extends ${renderType(parent, modulePathMapper, true)}`)
    }

    JsDocRenderer.renderProperties(descriptor.properties, tags, modulePathMapper)
    
    for (const example of examples) {
      tags.push(`@example <caption>${example.name}</caption> @lang ${example.lang}\n * ${example.content.trim().split("\n").join("\n * ")}`)
    }

    let result = this.formatComment(descriptor.node, tags, parseExistingJsDoc(descriptor.node, tags) || "")
    result += `export class ${descriptor.name} {\n`

    this.indent = "  "
    for (const method of descriptor.methods) {
      result += this.renderMethod(method, modulePathMapper, descriptor)
      if (method !== descriptor.methods[descriptor.methods.length - 1]) {
        result += "\n"
      }
    }
    this.indent = ""

    result += "}\n\n"
    return result
  }

  renderMethod(method: MethodDescriptor, modulePathMapper: ModulePathMapper, classDescriptor: Class | null): string {
    const tags = method.tags.slice()

    const paramNameToInfo = new Map<string, Tag>()
    let returns: Tag | null

    const parsed = method.jsDoc
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
          tags.push(printTag(tag))
        }
      }
    }

    for (const param of method.node.parameters) {
      let name = (<ts.Identifier>param.name).text
      let text = `@param`

      const type = param.type
      if (type != null) {
        text += ` ${renderTypes(this.generator.getTypeNamePathByNode(type), modulePathMapper)}`
      }

      text += ` ${name}`
      const tag = paramNameToInfo.get(name)
      if (tag != null && tag.description != null) {
        text += ` ${tag.description}`
      }
      tags.push(text)
    }

    if (classDescriptor != null) {
      // https://github.com/jsdoc3/jsdoc/issues/1137#issuecomment-281257286
      tags.push(`@function ${classDescriptor.modulePath}.${classDescriptor.name}#${method.name}`)
    }

    const signature = this.generator.program.getTypeChecker().getSignatureFromDeclaration(method.node)
    const returnTypes = this.generator.getTypeNames(signature.getReturnType(), method.node)
    // http://stackoverflow.com/questions/4759175/how-to-return-void-in-jsdoc
    if (!returnTypes.includes("void")) {
      let text = `@returns ${renderTypes(returnTypes, modulePathMapper)}`
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

  renderVariable(descriptor: Variable, modulePathMapper: ModulePathMapper): string {
    this.indent = ""

    const tags = [`@type ${renderTypes(descriptor.types, modulePathMapper)}`]

    if (descriptor.isConst) {
      tags.push("@constant")
    }

    let result = this.formatComment(descriptor.node, tags)
    // jsdoc cannot parse const, so, we always use var
    result += `export var ${descriptor.name}\n`
    return result
  }
  
  renderMember(descriptor: Descriptor) {
    const tags = [
      "@enum {number}"
    ]
    
    if (descriptor.readonly) {
      tags.push("@readonly") 
    }
    for (const property of descriptor.properties) {
      tags.push(`@property ${property.name}`) 
    }
    
    let result = this.formatComment(descriptor.node!, tags)
    result += `export var ${descriptor.name}\n`
    return result
  }

  // form http://stackoverflow.com/questions/10490713/how-to-document-the-properties-of-the-object-in-the-jsdoc-3-tag-this
  // doesn't produce properties table, so, we use property tags
  private static renderProperties(properties: Array<Property>, tags: Array<string>, modulePathMapper: ModulePathMapper): void {
    loop:
    for (const descriptor of properties) {
      const node = descriptor.node
      const existingJsDoc = JsDocRenderer.getComment(node)
      const parsed = existingJsDoc == null ? null : parseJsDoc(existingJsDoc, {unwrap: true})
      let defaultValue = descriptor.defaultValue
      let isOptional = descriptor.isOptional
      let description = parsed == null ? "" : parsed.description
      if (parsed != null) {
        for (const tag of parsed.tags) {
          switch (tag.title) {
            case "default":
              defaultValue = tag.description
              break
            
            case "private":
              continue loop
            
            case "required":
              isOptional = false
              break
            
            case "see":
              description += `\nSee: ${tag.description}`
              break
            
            case "deprecated":
              description += `\nDeprecated: {tag.description}`
              break
            
            default: {
              const sourceFile = node.getSourceFile()
              const leadingCommentRanges = ts.getLeadingCommentRanges(sourceFile.text, node.pos)
              const position = sourceFile.getLineAndCharacterOfPosition(leadingCommentRanges[0].pos)
              console.warn(`${path.basename(sourceFile.fileName)} ${position.line + 1}:${position.character} property level tag "${tag.title}" are not supported, please file issue`)
            }
          }
        }
      }

      let result = `@property ${renderTypes(descriptor.types, modulePathMapper)} `

      if (isOptional) {
        result += "["
      }
      result += descriptor.name

      if (defaultValue != null) {
        result += `=${defaultValue}`
      }

      if (isOptional) {
        result += "]"
      }

      if (description != null) {
        description = description.trim()
        if (description.length > 0) {
          // one \n is not translated to break as markdown does (because in the code newline means that we don't want to use long line and have to break)
          description = description
            .replace(/\n\n/g, "<br><br>")
            .replace(/\n/g, " ")
          // http://stackoverflow.com/questions/28733282/jsdoc-multiline-description-property
          result += ` ${description}`
        }
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
      tags.push(printTag(tag))
    }
  }

  return parsed == null ? null : parsed.description
}

function printTag(tag: Tag) {
  let text = `@${tag.title}`

  const caption = (<any>tag).caption
  if (caption != null) {
    text += ` <caption>${caption}</caption>`
  }

  if (tag.description != null) {
    text += ` ${tag.description}`
  }
  return text
}

// (oldPath: string) => oldPath

function renderTypes(names: Array<string | Type>, modulePathMapper: ModulePathMapper): string {
  return `{${_renderTypes(names, modulePathMapper)}}`
}

function _renderTypes(names: Array<string | Type>, modulePathMapper: ModulePathMapper): string {
  return names.map(it => renderType(it, modulePathMapper)).join(" | ")
}

function renderType(name: string | Type, modulePathMapper: ModulePathMapper, ignoreSubtypes = false): string {
  if (typeof name === "string") {
    return modulePathMapper(name)
  }
  const type = <Type>name
  if (ignoreSubtypes) {
    return modulePathMapper(type.name)
  }
  return modulePathMapper(type.name) + "<" + _renderTypes(type.subTypes, modulePathMapper) + ">"
}