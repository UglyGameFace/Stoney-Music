"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const defaultRoot = path.resolve(__dirname, "..");
const root = path.resolve(process.env.PUBLISH_AUDIT_ROOT || defaultRoot);
const forbiddenDirectoryNames = new Set(["node_modules", "plugins", "logs"]);
const forbiddenFileNames = new Set(["lavalink.jar"]);
const forbiddenExtensions = new Set([".jar", ".log", ".zip"]);
const errors = new Set();
const patterns = [
  [
    "Discord-token-like value",
    new RegExp(
      "(?:^|[^A-Za-z0-9_-])[MN][A-Za-z0-9_-]{20,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{20,}(?:$|[^A-Za-z0-9_-])"
    ),
  ],
  ["GitHub-token-like value", new RegExp("gh[pousr]_[A-Za-z0-9]{20,}")],
  ["private key", new RegExp("-{5}BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-{5}")],
];

function walkFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(fullPath, files);
    else if (entry.isFile()) files.push(path.relative(root, fullPath));
  }
  return files;
}

function publishFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split("\0").filter(Boolean);
  } catch {
    // A sanitized deployment directory may not contain .git. In that case,
    // audit the directory contents directly.
    return walkFiles(root);
  }
}

function checkPath(relative) {
  const normalized = relative.split(path.sep).join("/");
  const segments = normalized.split("/");
  const basename = segments.at(-1) || "";

  if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
    errors.add(`Forbidden runtime/dependency path: ${normalized}`);
    return false;
  }
  if (forbiddenFileNames.has(basename)) {
    errors.add(`Forbidden generated file: ${normalized}`);
    return false;
  }
  if (basename === ".env" || (basename.startsWith(".env.") && basename !== ".env.example")) {
    errors.add(`Forbidden environment file: ${normalized}`);
    return false;
  }
  if (forbiddenExtensions.has(path.extname(basename).toLowerCase())) {
    errors.add(`Forbidden generated/archive file: ${normalized}`);
    return false;
  }
  if (/^backup-/i.test(basename)) {
    errors.add(`Forbidden backup file: ${normalized}`);
    return false;
  }
  return true;
}

for (const relative of publishFiles()) {
  if (!checkPath(relative)) continue;
  const normalized = relative.split(path.sep).join("/");
  if (normalized === "scripts/audit-publish.js") continue;

  let contents;
  try {
    contents = fs.readFileSync(path.join(root, relative), "utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of patterns) {
    if (pattern.test(contents)) errors.add(`${label} found in ${normalized}`);
  }
}

if (errors.size) {
  console.error([...errors].join("\n"));
  process.exit(1);
}
console.log(
  "Publish audit passed: no tracked secret/runtime/archive files or common token patterns found."
);
