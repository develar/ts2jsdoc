import * as ts from "typescript"
import * as path from "path"
import { readFile } from "fs-extra-p"

export async function transpile(transpilator: (basePath: string, config: ts.ParsedCommandLine, tsConfig: any) => Promise<any>) {
  const paths = process.argv.slice(2)
  if (paths.length == 0) {
    paths.push(process.cwd())
  }
  return transpilePaths(paths, transpilator)
}

export async function transpilePaths(paths: Array<string>, transpilator: (basePath: string, config: ts.ParsedCommandLine, tsConfig: any) => Promise<any>) {
  for (const basePath of paths) {
    try {
      await build(basePath, transpilator)
    }
    catch (e) {
      if (!(e instanceof CompilationError)) {
        throw e
      }

      for (const diagnostic of e.errors) {
        if (diagnostic.file == null) {
          console.log(diagnostic.messageText)
          continue
        }

        const location = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!!)
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
        console.log(`${diagnostic.file.fileName} (${location.line + 1}, ${location.character + 1}): ${message}`)
      }
      process.exit(-1)
      return
    }
  }
}

async function build(basePath: string, transpilator: (basePath: string, config: ts.ParsedCommandLine, tsConfig: any) => Promise<any>) {
  const tsConfigPath = path.join(basePath, "tsconfig.json")
  const jsonResult = ts.parseConfigFileTextToJson(tsConfigPath, await readFile(tsConfigPath, "utf8"))
  if (jsonResult.error != null) {
    throw new CompilationError([jsonResult.error])
  }

  const result = ts.parseJsonConfigFileContent(jsonResult.config, ts.sys, basePath)
  checkErrors(result.errors)

  await transpilator(basePath, result, jsonResult.config)
}

export function checkErrors(errors: Array<ts.Diagnostic>): void {
  if (errors.length !== 0) {
    throw new CompilationError(errors)
  }
}

class CompilationError extends Error {
  constructor(public errors: Array<ts.Diagnostic>) {
    super("Compilation error")
  }
}

export function processTree(sourceFile: ts.SourceFile, replacer: (node: ts.Node) => boolean): void {
  function visit(node: ts.Node) {
    if (node.flags & ts.ModifierFlags.Private) {
      // skip private nodes
      return
    }

    if (!replacer(node)) {
      ts.forEachChild(node, visit)
    }
  }

  visit(sourceFile)
}