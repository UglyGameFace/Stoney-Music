"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const roots = [path.join(root, "src"), path.join(root, "test"), path.join(root, "scripts")];
const failures = [];
let checked = 0;

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const relative = path.relative(root, fullPath);
      try {
        const source = fs.readFileSync(fullPath, "utf8").replace(/^#!.*\n/, "");
        new vm.Script(source, { filename: relative });
        checked += 1;
      } catch (error) {
        failures.push(`${relative}: ${error.message}`);
      }
    }
  }
}

for (const directory of roots) {
  if (fs.existsSync(directory)) walk(directory);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Syntax check passed for ${checked} JavaScript files.`);
