"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { GuildConfigStore } = require("../src/config-store");

test("guild setup persists channel, optional roles, and recovery panel identity", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "guild-config.json");

  const first = new GuildConfigStore({ filePath });
  await first.load();
  assert.equal(first.hasSavedSetup("123"), false);
  await first.set("123", {
    musicTextChannelId: "456",
    roleVerifiedId: "789",
    roleVerified: "Optional Access Role",
    roleResidentId: null,
    roleResident: null,
    setupPanelChannelId: "111",
    setupPanelMessageId: "222",
    setupPanelVersion: "3",
  });
  assert.equal(first.hasSavedSetup("123"), true);

  const second = new GuildConfigStore({ filePath });
  await second.load();
  assert.equal(second.hasSavedSetup("123"), true);
  assert.deepEqual(second.get("123"), {
    musicTextChannelId: "456",
    roleVerifiedId: "789",
    roleVerified: "Optional Access Role",
    roleResidentId: null,
    roleResident: null,
    setupPanelChannelId: "111",
    setupPanelMessageId: "222",
    setupPanelVersion: "3",
  });
});

test("different servers keep completely isolated music setup", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-multiguild-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new GuildConfigStore({ filePath: path.join(directory, "guild-config.json") });
  await store.load();
  await store.set("guild-a", { musicTextChannelId: "channel-a" });
  await store.set("guild-b", { musicTextChannelId: "channel-b" });

  assert.equal(store.get("guild-a").musicTextChannelId, "channel-a");
  assert.equal(store.get("guild-b").musicTextChannelId, "channel-b");
});

test("recording a recovery panel does not count as completed music setup", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-panel-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new GuildConfigStore({ filePath: path.join(directory, "guild-config.json") });
  await store.load();
  await store.set("123", {
    setupPanelChannelId: "111",
    setupPanelMessageId: "222",
    setupPanelVersion: "3",
  });
  assert.equal(store.hasSavedSetup("123"), false);
  assert.equal(store.get("123").setupPanelMessageId, "222");
});

test("legacy environment channel defaults are ignored until setup saves a channel", async () => {
  const store = new GuildConfigStore({
    filePath: path.join(os.tmpdir(), `missing-stoney-${Date.now()}.json`),
    defaults: { musicTextChannelId: "old-channel" },
  });
  await store.load();
  assert.equal(store.get("123").musicTextChannelId, null);
  assert.equal(store.hasSavedSetup("123"), false);
});

test("setup stores no role gate when roles are not explicitly selected", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-config-clear-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new GuildConfigStore({ filePath: path.join(directory, "guild-config.json") });
  await store.load();
  const saved = await store.set("123", {
    musicTextChannelId: "456",
    roleVerifiedId: null,
    roleVerified: null,
    roleResidentId: null,
    roleResident: null,
  });
  assert.equal(saved.roleVerified, null);
  assert.equal(saved.roleResident, null);
  assert.equal(saved.setupPanelMessageId, null);
});
