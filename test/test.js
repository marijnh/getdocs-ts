const assert = require("assert")
const fs = require("fs")

const {gatherMany} = require("../src")

const grepArg = process.argv.indexOf("--grep")
const grep = grepArg < 0 ? null : new RegExp(process.argv[grepArg + 1])

describe("getdocs-ts", () => {
  let caseDir = __dirname + "/cases"
  let cases = []
  fs.readdirSync(caseDir).forEach(filename => {
    let isTS = /^([^\.]+)\.ts$/.exec(filename)
    if (!isTS) return
    cases.push({name: isTS[1],
                skipped: grep && !grep.test(isTS[1]),
                filename: `test/cases/${filename}`})
  })

  let result = gatherMany(cases.filter(c => !c.skipped)), i = 0
  for (let c of cases) {
    if (c.skipped) it.skip(c.name, () => {})
    else it(c.name, () => {
      let expected = JSON.parse(fs.readFileSync(`${caseDir}/${c.name}.json`, "utf8"))
      let returned = result[i++]
      if (process.env.PRINT_JSON) console.log(JSON.stringify(returned, null, 2))
      assert.deepEqual(returned, expected)
    })
  }
})
