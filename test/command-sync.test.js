"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  commandNames,
  syncApplicationCommands,
  verifyRegisteredCommands,
} = require("../src/command-sync");

function fakeGuilds(entries) {
  return { cache: new Map(entries.map((guild) => [guild.id, guild])) };
}

test("commandNames returns sorted slash-command names", () => {
  assert.deepEqual(commandNames([{ name: "skip" }, { name: "play" }]), ["play", "skip"]);
});

test("verifyRegisteredCommands rejects incomplete Discord responses", () => {
  assert.throws(
    () => verifyRegisteredCommands([{ name: "play" }, { name: "skip" }], [{ name: "play" }]),
    /Missing: skip/
  );
});

test("guild command sync verifies the connected server and reports accepted names", async () => {
  const calls = [];
  const logs = [];
  const rest = {
    async put(route, options) {
      calls.push({ route, options });
      return options.body.map((command, index) => ({ ...command, id: String(index + 1) }));
    },
  };

  const result = await syncApplicationCommands({
    rest,
    applicationId: "111111111111111111",
    guildId: "222222222222222222",
    guilds: fakeGuilds([{ id: "222222222222222222", name: "Stoney Balonney" }]),
    commands: [{ name: "play" }, { name: "queue" }],
    logger: { log: (message) => logs.push(message), warn: (message) => logs.push(message) },
  });

  assert.equal(result.scope, "guild");
  assert.deepEqual(result.commandNames, ["play", "queue"]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].route, /applications\/111111111111111111\/guilds\/222222222222222222\/commands/);
  assert.match(logs.join("\n"), /Discord accepted 2 guild commands/);
  assert.match(logs.join("\n"), /\/play, \/queue/);
});

test("wrong GUILD_ID recovers to the only connected server", async () => {
  const warnings = [];
  const result = await syncApplicationCommands({
    rest: { put: async (_route, options) => options.body },
    applicationId: "111111111111111111",
    guildId: "999999999999999999",
    guilds: fakeGuilds([{ id: "222222222222222222", name: "Stoney Balonney" }]),
    commands: [{ name: "setup" }],
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });
  assert.equal(result.guildId, "222222222222222222");
  assert.match(warnings.join("\n"), /Configured GUILD_ID 999999999999999999 is not connected/);
});

test("wrong GUILD_ID still fails when more than one server is connected", async () => {
  await assert.rejects(
    syncApplicationCommands({
      rest: { put: async () => [] },
      applicationId: "111111111111111111",
      guildId: "999999999999999999",
      guilds: fakeGuilds([
        { id: "222222222222222222", name: "Stoney Balonney" },
        { id: "333333333333333333", name: "Other Server" },
      ]),
      commands: [{ name: "play" }],
      logger: { log() {}, warn() {} },
    }),
    /GUILD_ID 999999999999999999 is not a server this bot is connected to/
  );
});

test("missing GUILD_ID auto-detects the only connected server", async () => {
  const warnings = [];
  const calls = [];
  const result = await syncApplicationCommands({
    rest: {
      put: async (route, options) => {
        calls.push(route);
        return options.body;
      },
    },
    applicationId: "111111111111111111",
    guildId: null,
    guilds: fakeGuilds([{ id: "222222222222222222", name: "Stoney Balonney" }]),
    commands: [{ name: "setup" }, { name: "play" }],
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.equal(result.scope, "guild");
  assert.equal(result.guildId, "222222222222222222");
  assert.match(calls[0], /guilds\/222222222222222222\/commands/);
  assert.match(warnings.join("\n"), /Auto-detected/);
});

test("missing GUILD_ID uses global registration when no single server is available", async () => {
  const warnings = [];
  const result = await syncApplicationCommands({
    rest: { put: async (_route, options) => options.body },
    applicationId: "111111111111111111",
    guildId: null,
    guilds: fakeGuilds([]),
    commands: [{ name: "play" }],
    logger: { log() {}, warn: (message) => warnings.push(message) },
  });

  assert.equal(result.scope, "global");
  assert.match(warnings.join("\n"), /zero or multiple servers/);
});
