import * as ts from "typescript"
import * as path from "path"
import { emptyDir, readdir, readFile, readJson, writeFile } from "fs-extra-p"
import { Descriptor, Member, Variable } from "./psi"
import BluebirdPromise from "bluebird-lst"
import { Example, generate, JsDocGenerator, ModulePathMapper, TsToJsdocOptions } from "./JsDocGenerator"

function computeModuleNameMappings(generator: JsDocGenerator) {
  const mainModuleName = generator.moduleName
  const mainPsi = generator.moduleNameToResult.get(mainModuleName!!)!!
  const oldModulePathToNew = new Map<string, string>()
  for (const [id, names] of generator.mainMappings) {
    const psi = generator.moduleNameToResult.get(id)!!
    for (const name of names) {
      if (moveMember(psi.classes, mainPsi.classes, name, mainModuleName)) {
        oldModulePathToNew.set(`module:${id}.${name}`, `module:${mainModuleName}.${name}`)
        continue
      }

      moveMember(psi.functions, mainPsi.functions, name) || moveMember(psi.members, mainPsi.members, name)
    }
  }
  return oldModulePathToNew
}

function moveMember<T extends Member>(members: Array<T>, mainPsiMembers: Array<T>, name: string, newId: string | null = null): boolean {
  const index = members.findIndex(it => it.name === name)
  if (index < 0) {
    return false
  }

  const member = members[index]
  if (newId != null) {
    (<any>member).modulePath = "module:" + newId
  }

  mainPsiMembers.push(member)
  members.splice(index, 1)
  return true
}

export async function generateAndWrite(basePath: string, config: ts.ParsedCommandLine, tsConfig: any) {
  let packageData: any = {name: "packageJsonNotDefined"}
  try {
    packageData = await readJson(path.join(basePath, "package.json"))
  }
  catch (e) {
  }

  const options: TsToJsdocOptions = typeof tsConfig.jsdoc === "string" ? {out: tsConfig.jsdoc} : tsConfig.jsdoc
  if (options.out == null) {
    throw new Error("Please specify out in the tsConfig.jsdoc (https://github.com/develar/ts2jsdoc#generate-jsdoc-from-typescript)")
  }

  const generator = generate(basePath, config, packageData.name, packageData == null ? null : packageData.main, options)

  const out = path.resolve(basePath, options.out)
  console.log(`Generating JSDoc to ${out}`)
  await emptyDir(out)

  const oldModulePathToNew = computeModuleNameMappings(generator)

  const exampleDir = options.examples == null ? null : path.resolve(basePath, options.examples)
  const existingClassExampleDirs = exampleDir == null ? null : new Set((await readdir(exampleDir)).filter(it => it[0] != "." && !it.includes(".")))

  for (const [moduleId, psi] of generator.moduleNameToResult.entries()) {
    const modulePathMapper: ModulePathMapper = oldPath => {
      if (!oldPath.startsWith("module:")) {
        return oldPath
      }

      const result = oldModulePathToNew.get(oldPath)
      if (result != null) {
        return result
      }

      if (moduleId === generator.moduleName && options.externalIfNotMain != null) {
        // external:electron-builder/out/platformPackager.PlatformPackager is not rendered by jsdoc2md,
        // only PlatformPackager
        const dotIndex = oldPath.lastIndexOf(".")
        const value = oldPath.substring(dotIndex + 1)
        externalToModuleName.set(value, oldPath.substring(oldPath.indexOf(":") + 1, dotIndex))
        return `external:${value}`
      }

      return oldPath
    }

    let result = ""
    const externalToModuleName = new Map<string, string>()
    for (const d of copyAndSort(psi.members)) {
      if ((<any>d).kind == null) {
        result += generator.renderer.renderVariable(<Variable>d, modulePathMapper)
      }
      else {
        result += generator.renderer.renderMember(<Descriptor>d)
      }
    }

    for (const d of copyAndSort(psi.classes)) {
      let examples: Array<Example> = []
      if (existingClassExampleDirs != null && existingClassExampleDirs.has(d.name)) {
        const dir = path.join(exampleDir!!, d.name)
        examples = await BluebirdPromise.map((await readdir(dir)).filter(it => it[0] != "." && it.includes(".")), async it => {
          const ext = path.extname(it)
          return <Example>{
            name: path.basename(it, ext),
            content: await readFile(path.join(dir, it), "utf8"),
            lang: ext
          }
        })
      }

      result += generator.renderer.renderClassOrInterface(d, modulePathMapper, examples)
    }

    for (const d of copyAndSort(psi.functions)) {
      result += generator.renderer.renderMethod(d, modulePathMapper, null)
    }

    if (result === "") {
      continue
    }

    let externalJsDoc = ""
    for (const [external, moduleId] of externalToModuleName) {
      externalJsDoc += `/**\n* @external ${external}\n* @see ${options.externalIfNotMain}#module_${moduleId}.${external}\n*/\n`
    }

    await writeFile(path.join(out, moduleId.replace(/\//g, "-") + ".js"), `${externalJsDoc}/** 
 * @module ${moduleId}
 */

${result}`)
  }
}

function copyAndSort<T extends Member>(members: Array<T>): Array<T> {
  return members.slice().sort((a, b) => a.name.localeCompare(b.name))
}