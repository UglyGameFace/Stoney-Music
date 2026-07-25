"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadEnvironment, ENV_LOADED_MARKER } = require("../src/env");

test("environment loader loads one canonical file once even when paths repeat", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-env-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const envPath = path.join(directory, ".env");
  fs.writeFileSync(envPath, "STONEY_TEST_VALUE=loaded-once\n");

  const env = {};
  const messages = [];
  const logger = { log: (message) => messages.push(message) };
  const fakeDotenv = {
    config({ path: file, processEnv }) {
      const [key, value] = fs.readFileSync(file, "utf8").trim().split("=");
      processEnv[key] = value;
      return { parsed: { [key]: value } };
    },
  };

  const first = loadEnvironment({
    env,
    candidates: [envPath, envPath],
    force: true,
    logger,
    dotenv: fakeDotenv,
  });
  const second = loadEnvironment({ env, candidates: [envPath], logger });

  assert.equal(first.loaded, true);
  assert.equal(second.skipped, true);
  assert.equal(env.STONEY_TEST_VALUE, "loaded-once");
  assert.equal(env[ENV_LOADED_MARKER], "1");
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Loaded environment file/);
});
