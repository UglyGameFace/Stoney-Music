"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const auditPath = path.resolve(__dirname, "..", "scripts", "audit-publish.js");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function runAudit(root) {
  return spawnSync(process.execPath, [auditPath], {
    cwd: root,
    env: { ...process.env, PUBLISH_AUDIT_ROOT: root },
    encoding: "utf8",
  });
}

function createTrackedFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-publish-audit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  fs.writeFileSync(path.join(root, "safe.txt"), "safe\n");
  git(root, ["add", "safe.txt"]);
  return root;
}

test("publish audit ignores installed but untracked dependencies", (t) => {
  const root = createTrackedFixture(t);
  const dependencyPath = path.join(root, "node_modules", "example");
  fs.mkdirSync(dependencyPath, { recursive: true });
  fs.writeFileSync(path.join(dependencyPath, "index.js"), "module.exports = true;\n");

  const result = runAudit(root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Publish audit passed/);
});

test("publish audit rejects committed dependencies and environment files", (t) => {
  const root = createTrackedFixture(t);
  const dependencyPath = path.join(root, "node_modules", "example");
  fs.mkdirSync(dependencyPath, { recursive: true });
  fs.writeFileSync(path.join(dependencyPath, "index.js"), "module.exports = true;\n");
  fs.writeFileSync(path.join(root, ".env.production"), "TOKEN=not-a-real-token\n");
  git(root, ["add", "-f", "node_modules/example/index.js", ".env.production"]);

  const result = runAudit(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Forbidden runtime\/dependency path/);
  assert.match(result.stderr, /Forbidden environment file/);
});
