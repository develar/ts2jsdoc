import * as ts from "typescript"
import { Annotation } from "doctrine"

export interface Member {
  readonly name: string
}

export interface MethodDescriptor extends Member {
  readonly tags: Array<string>

  readonly isProtected?: boolean

  readonly node: ts.SignatureDeclaration
  readonly jsDoc: Annotation | null
}

export interface Property extends Member {
  readonly types: Array<string | Type>

  readonly node: ts.PropertySignature | ts.PropertyDeclaration

  readonly defaultValue: any
  readonly isOptional: boolean
}

export interface Class extends Member {
  readonly modulePath: string

  readonly node: ts.Node
  readonly isInterface: boolean
  readonly properties: Array<Property>
  readonly methods: Array<MethodDescriptor>
  readonly parents: Array<string | Type>
}

export interface Variable extends Member {
  readonly node: ts.VariableStatement
  readonly isConst: boolean
  readonly types: Array<string | Type>
}

export interface SourceFileDescriptor {
  readonly classes: Array<Class>
  readonly functions: Array<MethodDescriptor>
  readonly members: Array<Variable | Descriptor>
}

export interface SourceFileModuleInfo {
  readonly id: string
  readonly isMain: boolean
}

export interface Descriptor extends Member {
  node?: ts.Node

  id?: string
  name: string
  // noinspection SpellCheckingInspection
  longname?: string
  kind: "enum" | "member"
  scope: "global" | "static"
  description?: string
  type: DescriptorType
  properties?: Array<Descriptor>

  memberof?: string

  readonly?: boolean
}

export interface DescriptorType {
  names: Array<string>
}

export interface Type {
  name: string
  subTypes: Array<string | Type>
}