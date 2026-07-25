"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const application = fs.readFileSync(path.join(root, "application.yml"), "utf8");
const start = fs.readFileSync(path.join(root, "start.sh"), "utf8");
const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
const discloud = fs.readFileSync(path.join(root, "discloud.config"), "utf8");

test("Lavalink config uses current plugins and no retired YouTube clients", () => {
  assert.match(application, /youtube-plugin:1\.18\.1/);
  assert.doesNotMatch(application, /lavasrc-plugin|plugins:\s*\n\s*lavasrc:/);
  for (const retired of ["ANDROID_TESTSUITE", "TVHTML5EMBEDDED", "WEB_EMBEDDED"]) {
    const configuredLine = new RegExp(`^\\s*-\\s+${retired}\\s*$`, "m");
    assert.doesNotMatch(application, configuredLine);
  }
  for (const current of ["MUSIC", "ANDROID_VR", "WEB", "WEBEMBEDDED", "TVHTML5_SIMPLY"]) {
    assert.match(application, new RegExp(`^\\s*-\\s+${current}\\s*$`, "m"));
  }
});

test("unused credentialed mirror plugin and unsafe sources are absent", () => {
  assert.doesNotMatch(application, /lavasrc-plugin|applemusic:\s*true|spotify:\s*true/);
  assert.match(application, /http:\s*false/);
  assert.match(application, /local:\s*false/);
  assert.match(application, /password:\s*"\$\{LAVALINK_PASSWORD\}"/);
});

test("start script pins DAVE-capable Lavalink and supervises both processes", () => {
  assert.match(start, /EXPECTED_LAVALINK_VERSION="\$\{LAVALINK_VERSION:-4\.2\.2\}"/);
  assert.match(start, /wait -n "\$LAVALINK_PID" "\$BOT_PID"/);
  assert.doesNotMatch(start, /exec node src\/index\.js/);
});

test("CI and Discloud use the committed dependency lockfile", () => {
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.doesNotMatch(workflow, /npm install/);
  assert.match(discloud, /^BUILD=npm ci --omit=dev --ignore-scripts$/m);
  assert.equal(fs.existsSync(path.join(root, "package-lock.json")), true);
});

test("publishable tree does not contain a live environment file", () => {
  assert.equal(fs.existsSync(path.join(root, ".env")), false);
});

test("runtime uses one canonical resolver and current dependency line", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const index = fs.readFileSync(path.join(root, "src", "index.js"), "utf8");
  const player = fs.readFileSync(path.join(root, "src", "player.js"), "utf8");

  assert.equal(packageJson.dependencies["discord.js"], "14.26.4");
  assert.equal(packageJson.dependencies.dotenv, "17.4.2");
  assert.equal(packageJson.dependencies.shoukaku, "4.3.0");
  assert.match(index, /resolveQuery\(query\)/);
  assert.match(index, /guild\.shardId/);
  assert.match(index, /deferReply\(\)/);
  assert.doesNotMatch(index, /data\?\.tracks\s*\|\|\s*res\?\.tracks/);
  assert.match(player, /getIdealNode\(\)/);
});
