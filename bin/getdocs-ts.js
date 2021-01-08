#!/usr/bin/env node
const {gather} = require("../src")
console.log(JSON.stringify(gather({filename: process.argv[2]}), null, 2))
