#!/usr/bin/env node
const gettypes = require("../src")
const items = gettypes.gather({filename: process.argv[2]})
console.log(JSON.stringify(items, null, 2))
