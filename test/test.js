const assert = require("assert")
const fs = require("fs")

const gettypes = require("../src")

describe("gettypes", () => {
  const caseDir = __dirname + "/cases"
  fs.readdirSync(caseDir).forEach(filename => {
    const isTS = /^([^\.]+)\.ts$/.exec(filename)
    if (!isTS) return

    it(isTS[1], () => {
      const expected = JSON.parse(fs.readFileSync(`${caseDir}/${isTS[1]}.json`, "utf8"))
      const returned = gettypes.gather({filename: `test/cases/${filename}`})
      if (process.env.PRINT_JSON) console.log(JSON.stringify(returned, null, 2))
      assert.deepEqual(returned, expected)
    })
  })
})
