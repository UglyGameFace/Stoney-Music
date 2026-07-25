"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const applicationPath = path.join(root, "application.yml");
const application = fs.readFileSync(applicationPath, "utf8");
const requiredEnv = ["DISCORD_TOKEN", "MUSIC_TEXT_CHANNEL_ID", "LAVALINK_PASSWORD"];
let failed = false;

function pass(message) {
  console.log(`✅ ${message}`);
}

function fail(message) {
  failed = true;
  console.error(`❌ ${message}`);
}

for (const key of requiredEnv) {
  if (process.env[key]) pass(`${key} is present`);
  else fail(`${key} is missing`);
}

for (const expectation of [
  ["youtube-source 1.18.1", /youtube-plugin:1\.18\.1/],
  ["environment-backed Lavalink password", /password:\s*"\$\{LAVALINK_PASSWORD\}"/],
]) {
  if (expectation[1].test(application)) pass(expectation[0]);
  else fail(`application.yml is missing ${expectation[0]}`);
}

for (const retired of ["ANDROID_TESTSUITE", "TVHTML5EMBEDDED", "WEB_EMBEDDED"]) {
  if (new RegExp(`^\\s*-\\s+${retired}\\s*$`, "m").test(application)) {
    fail(`retired YouTube client is configured: ${retired}`);
  }
}

const jarPath = path.join(root, "lavalink.jar");
if (!fs.existsSync(jarPath)) {
  console.log("ℹ️ lavalink.jar is not bundled; start.sh will download pinned Lavalink 4.2.2.");
} else {
  const unzip = spawnSync("unzip", ["-p", jarPath, "META-INF/MANIFEST.MF"], {
    encoding: "utf8",
  });
  const version = unzip.stdout.match(/^Implementation-Version:\s*(.+)$/m)?.[1]?.trim();
  if (version === "4.2.2") pass("bundled Lavalink version is 4.2.2");
  else fail(`bundled Lavalink version is ${version || "unknown"}; expected 4.2.2`);
}

if (fs.existsSync(path.join(root, ".env"))) {
  console.log("ℹ️ Local .env exists. It is ignored by Git; do not include it in deployment archives shared publicly.");
}

if (failed) process.exit(1);
