"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearLegacyGuildCommands,
  commandIdMap,
  commandNames,
  syncApplicationCommands,
  verifyRegisteredCommands,
} = require("../src/command-sync");

test("commandNames returns sorted slash-command names", () => {
  assert.deepEqual(commandNames([{ name: "skip" }, { name: "play" }]), ["play", "skip"]);
});

test("commandIdMap exposes clickable mention IDs by command name", () => {
  assert.deepEqual(
    commandIdMap([
      { id: "111", name: "play" },
      { id: "222", name: "setup" },
      { name: "missing-id" },
    ]),
    { play: "111", setup: "222" }
  );
});

test("verifyRegisteredCommands rejects incomplete Discord responses", () => {
  assert.throws(
    () => verifyRegisteredCommands([{ name: "play" }, { name: "skip" }], [{ name: "play" }]),
    /Missing: skip/
  );
});

test("public sync always registers one global command set", async () => {
  const calls = [];
  const logs = [];
  const rest = {
    async put(route, options) {
      calls.push({ method: "put", route, options });
      return options.body.map((command, index) => ({ ...command, id: String(index + 1) }));
    },
    async get(route) {
      calls.push({ method: "get", route });
      return [];
    },
  };

  const result = await syncApplicationCommands({
    rest,
    applicationId: "111111111111111111",
    guildId: null,
    commands: [{ name: "play" }, { name: "queue" }],
    logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });

  assert.equal(result.scope, "global");
  assert.equal(result.guildId, null);
  assert.deepEqual(result.commandNames, ["play", "queue"]);
  assert.deepEqual(result.commandIds, { play: "1", queue: "2" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].route, /applications\/111111111111111111\/commands$/);
  assert.doesNotMatch(calls[0].route, /guilds/);
  assert.match(logs.join("\n"), /public global commands/);
});

test("legacy GUILD_ID is used only to remove the old guild-only command set", async () => {
  const calls = [];
  const logs = [];
  const rest = {
    async put(route, options) {
      calls.push({ method: "put", route, options });
      if (options.body.length === 0) return [];
      return options.body.map((command, index) => ({ ...command, id: String(index + 1) }));
    },
    async get(route) {
      calls.push({ method: "get", route });
      return [{ id: "old", name: "play" }];
    },
  };

  const result = await syncApplicationCommands({
    rest,
    applicationId: "111111111111111111",
    guildId: "222222222222222222",
    commands: [{ name: "play" }],
    logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });

  assert.equal(result.scope, "global");
  assert.equal(calls[0].method, "put");
  assert.doesNotMatch(calls[0].route, /guilds/);
  assert.match(calls[1].route, /guilds\/222222222222222222\/commands$/);
  assert.equal(calls[2].method, "put");
  assert.deepEqual(calls[2].options.body, []);
  assert.match(logs.join("\n"), /Removed 1 legacy guild-only commands/);
});

test("legacy cleanup failure does not undo successful public registration", async () => {
  const warnings = [];
  const rest = {
    async put(_route, options) {
      return options.body.map((command, index) => ({ ...command, id: String(index + 1) }));
    },
    async get() {
      throw new Error("missing access");
    },
  };

  const result = await syncApplicationCommands({
    rest,
    applicationId: "111111111111111111",
    guildId: "222222222222222222",
    commands: [{ name: "setup" }],
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.equal(result.scope, "global");
  assert.match(warnings.join("\n"), /Could not remove legacy guild-only commands/);
});

test("clearLegacyGuildCommands is a no-op without a migration guild ID", async () => {
  const cleared = await clearLegacyGuildCommands({
    rest: { get: async () => assert.fail("should not query") },
    applicationId: "111111111111111111",
    legacyGuildId: null,
  });
  assert.equal(cleared, false);
});
