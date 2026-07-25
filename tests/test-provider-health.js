"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { PlayerManager } = require("../src/player");
const {
  ProviderHealthStore,
  isYoutubeHostWideBlock,
  normalizeNodeKey,
  providerForSearchIdentifier,
} = require("../src/provider-health");

const HOST_BLOCK_MESSAGE = `(yts.version: 1.18.1) All clients failed to load the item.
Client [ANDROID_VR] failed: This video requires login.
Client [WEB] failed: This video requires login.
Client [WEB_EMBEDDED_PLAYER] failed: Video player configuration error.
Client [TVHTML5_SIMPLY] failed: Sign in to confirm you’re not a bot.`;

function youtubeTrack() {
  return {
    sourceName: "youtube",
    title: "I See Why",
    author: "MoneyBagg Yo",
    encoded: "youtube-encoded",
  };
}

async function temporaryHealthPath() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "stoney-provider-health-"));
  return { directory, filePath: path.join(directory, "provider-health.json") };
}

test("host-wide YouTube challenge is detected without treating ordinary video errors as node blocks", () => {
  assert.equal(
    isYoutubeHostWideBlock(youtubeTrack(), { exception: { message: HOST_BLOCK_MESSAGE } }),
    true
  );
  assert.equal(
    isYoutubeHostWideBlock(youtubeTrack(), { exception: { message: "Video is private." } }),
    false
  );
  assert.equal(
    isYoutubeHostWideBlock({ sourceName: "soundcloud" }, { exception: { message: HOST_BLOCK_MESSAGE } }),
    false
  );
});

test("provider identifier detection includes searches and direct links", () => {
  assert.equal(providerForSearchIdentifier("ytsearch:MoneyBagg Yo - I See Why"), "youtube");
  assert.equal(providerForSearchIdentifier("ytmsearch:MoneyBagg Yo - I See Why"), "youtube");
  assert.equal(providerForSearchIdentifier("https://youtu.be/abc123"), "youtube");
  assert.equal(providerForSearchIdentifier("https://music.youtube.com/watch?v=abc123"), "youtube");
  assert.equal(providerForSearchIdentifier("scsearch:MoneyBagg Yo - I See Why"), "soundcloud");
  assert.equal(providerForSearchIdentifier("https://soundcloud.com/artist/song"), "soundcloud");
});

test("provider health persists per Lavalink node and expires after cooldown", async (t) => {
  const { directory, filePath } = await temporaryHealthPath();
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const localNode = normalizeNodeKey([{ name: "main", url: "127.0.0.1:2333", secure: false }]);
  const remoteNode = normalizeNodeKey([{ name: "main", url: "music.example.com:443", secure: true }]);

  const first = new ProviderHealthStore({
    filePath,
    nodeKey: localNode,
    youtubeCooldownMs: 120_000,
    logger: { warn() {} },
  });
  await first.load();
  await first.block("youtube", "not-a-bot challenge", { now, cooldownMs: 120_000 });
  assert.equal(first.isBlocked("youtube", now + 1), true);
  assert.equal(first.isBlocked("youtube", now + 120_001), false);

  const restored = new ProviderHealthStore({
    filePath,
    nodeKey: localNode,
    youtubeCooldownMs: 120_000,
    logger: { warn() {} },
  });
  await restored.load();
  assert.equal(restored.isBlocked("youtube", now + 60_000), true);

  const external = new ProviderHealthStore({
    filePath,
    nodeKey: remoteNode,
    youtubeCooldownMs: 120_000,
    logger: { warn() {} },
  });
  await external.load();
  assert.equal(external.isBlocked("youtube", now + 60_000), false);
});

test("PlayerManager skips every YouTube path while the circuit is open but still resolves SoundCloud", async () => {
  const manager = Object.create(PlayerManager.prototype);
  const calls = [];
  const logs = [];
  manager.providerHealthReady = Promise.resolve();
  manager.providerHealth = {
    nodeKey: "main|127.0.0.1:2333|plain",
    isBlocked: (provider) => provider === "youtube",
    blockedUntil: () => 123456,
    remainingMs: () => 60000,
  };
  manager._providerSkipLoggedUntil = new Map();
  manager.logger = { warn: (...args) => logs.push(args) };
  manager.resolve = async (identifier) => {
    calls.push(identifier);
    return { loadType: "search", data: [{ encoded: "ok", info: { sourceName: "soundcloud" } }] };
  };

  assert.deepEqual(await manager.resolveWithProviderHealth("ytsearch:test"), {
    loadType: "empty",
    data: [],
  });
  assert.deepEqual(await manager.resolveWithProviderHealth("ytmsearch:test"), {
    loadType: "empty",
    data: [],
  });
  assert.deepEqual(await manager.resolveWithProviderHealth("https://youtu.be/test"), {
    loadType: "empty",
    data: [],
  });
  await manager.resolveWithProviderHealth("scsearch:test");

  assert.deepEqual(calls, ["scsearch:test"]);
  assert.equal(logs.length, 1);
});

test("PlayerManager opens the YouTube circuit only for the host-wide challenge signature", async () => {
  const manager = Object.create(PlayerManager.prototype);
  const blocks = [];
  manager.providerHealthReady = Promise.resolve();
  manager.providerHealth = {
    nodeKey: "main|127.0.0.1:2333|plain",
    youtubeCooldownMs: 21_600_000,
    block: async (...args) => {
      blocks.push(args);
      return Date.now() + 21_600_000;
    },
  };
  manager._providerSkipLoggedUntil = new Map([["youtube", 1]]);
  manager.logger = { warn() {} };

  assert.equal(
    await manager.noteProviderFailure(
      youtubeTrack(),
      { exception: { message: HOST_BLOCK_MESSAGE } },
      "All clients failed"
    ),
    true
  );
  assert.equal(blocks.length, 1);
  assert.equal(manager._providerSkipLoggedUntil.has("youtube"), false);

  assert.equal(
    await manager.noteProviderFailure(
      youtubeTrack(),
      { exception: { message: "Video is private" } },
      "Video is private"
    ),
    false
  );
  assert.equal(blocks.length, 1);
});
