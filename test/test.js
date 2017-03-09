const { generate } = require("../out/JsDocGenerator")
const { transpilePaths } = require("../out/util")
const path = require("path")

test("interface from namespace", () => {
  return transpilePaths([path.join(__dirname, "fixtures")], (basePath, config, tsConfig) => {
    const data = generate(basePath, config, "test", null)
    expect(data.moduleNameToResult).toMatchSnapshot()
    return Promise.resolve(data)
  })
});