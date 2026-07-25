"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { GuildConfigStore } = require("../src/config-store");

test("guild setup persists and reloads channel and role IDs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "guild-config.json");

  const first = new GuildConfigStore({
    filePath,
    defaults: { roleVerified: "Verified", roleResident: "Resident" },
  });
  await first.load();
  await first.set("123", {
    musicTextChannelId: "456",
    roleVerifiedId: "789",
    roleVerified: "Verified",
    roleResidentId: "987",
    roleResident: "Resident",
  });

  const second = new GuildConfigStore({ filePath });
  await second.load();
  assert.deepEqual(second.get("123"), {
    musicTextChannelId: "456",
    roleVerifiedId: "789",
    roleVerified: "Verified",
    roleResidentId: "987",
    roleResident: "Resident",
  });
});

test("guild setup falls back to environment defaults before first save", async () => {
  const store = new GuildConfigStore({
    filePath: path.join(os.tmpdir(), `missing-stoney-${Date.now()}.json`),
    defaults: {
      musicTextChannelId: "111",
      roleVerified: "Verified",
      roleResident: "Resident",
    },
  });
  await store.load();
  assert.equal(store.get("123").musicTextChannelId, "111");
});

test("setup can explicitly disable role gates when matching roles do not exist", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-config-clear-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new GuildConfigStore({
    filePath: path.join(directory, "guild-config.json"),
    defaults: { roleVerified: "Verified", roleResident: "Resident" },
  });
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
});
