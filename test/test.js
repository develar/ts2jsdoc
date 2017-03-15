const { generate } = require("../out/JsDocGenerator")
const { transpilePaths } = require("../out/util")
const path = require("path")

test("interface from namespace", () => {
  return transpilePaths([path.join(__dirname, "fixtures")], async (basePath, config, tsConfig) => {
    const generator = generate(basePath, config, "test", null)
    
    let result = ""
    for (const [moduleId, psi] of generator.moduleNameToResult.entries()) {
        for (const d of psi.members) {
          result += generator.renderer.renderVariable(d)
        }
        for (const d of psi.classes) {
          result += generator.renderer.renderClassOrInterface(d, new Map())
        }
        for (const d of psi.functions) {
          result += generator.renderer.renderMethod(d)
        }
    
      result = `/** 
     * @module ${moduleId}
     */
    
    ${result}`
      }
    expect(result).toMatchSnapshot()
  })
});