"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const forbiddenNames = new Set([".env", "lavalink.jar", "node_modules", "plugins", "logs"]);
const forbiddenExtensions = new Set([".jar", ".log", ".zip"]);
const errors = [];
const patterns = [
  ["Discord-token-like value", new RegExp("(?:^|[^A-Za-z0-9_-])[MN][A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])")],
  ["GitHub-token-like value", new RegExp("gh[pousr]_[A-Za-z0-9]{20,}")],
  ["private key", new RegExp("-{5}BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-{5}")],
];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const fullPath = path.join(directory, entry.name);
    const relative = path.relative(root, fullPath);

    if (forbiddenNames.has(entry.name)) {
      errors.push(`Forbidden runtime/secret path: ${relative}`);
      continue;
    }
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (forbiddenExtensions.has(path.extname(entry.name).toLowerCase())) {
      errors.push(`Forbidden generated/archive file: ${relative}`);
      continue;
    }
    if (relative === path.join("scripts", "audit-publish.js")) continue;

    let contents;
    try {
      contents = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    for (const [label, pattern] of patterns) {
      if (pattern.test(contents)) errors.push(`${label} found in ${relative}`);
    }
  }
}

walk(root);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Publish audit passed: no secret/runtime/archive files or common token patterns found.");
