"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const {
  MIN_STABLE_PLAYBACK_POSITION_MS,
  PlaybackGuildPlayer,
} = require("../src/playback-guild-player");
const { PRODUCTION_FALLBACK_PREFIXES } = require("../src/player");

function track(name, overrides = {}) {
  return {
    title: name,
    author: "Artist",
    uri: `https://example.test/${encodeURIComponent(name)}`,
    durationMs: 180_000,
    sourceName: "youtube",
    identifier: name,
    requesterId: "requester",
    encoded: `encoded-${name}`,
    playbackCandidateTitle: name,
    playbackCandidateAuthor: "Artist",
    playbackIdentity: {
      title: name,
      artist: "Artist",
      durationMs: 180_000,
      durationTrusted: true,
      sourceType: "manual-search",
      requestedQuery: `Artist - ${name}`,
    },
    fallbackTriedKeys: [],
    fallbackAttemptCount: 0,
    ...overrides,
  };
}

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.volumes = [];
    this.stopCalls = 0;
    this.position = 0;
  }

  async playTrack(payload) {
    this.played.push(payload.track.encoded);
    this.position = 0;
  }

  async setGlobalVolume(volume) {
    this.volumes.push(volume);
  }

  async stopTrack() {
    this.stopCalls += 1;
  }
}

class FakeShoukaku {
  constructor(player) {
    this.player = player;
  }

  async joinVoiceChannel() {
    return this.player;
  }
}

async function connectedPlayer({ resolveFallback, onFallbackVerified, onFallbackFailed } = {}) {
  const fake = new FakePlayer();
  const logs = [];
  const player = new PlaybackGuildPlayer(new FakeShoukaku(fake), "guild", {
    logger: {
      log: (...args) => logs.push(["log", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    resolveFallback,
    onFallbackVerified,
    onFallbackFailed,
    playbackStartTimeoutMs: 1_000,
  });
  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  return { player, fake, logs };
}

test("a mirror is not confirmed until playback position advances", async () => {
  const original = track("Requested", { encoded: "original" });
  const mirror = track("Requested", {
    encoded: "mirror",
    sourceName: "soundcloud",
    isFallback: true,
    fallbackScore: 0.99,
  });
  const verified = [];
  const { player, fake, logs } = await connectedPlayer({
    resolveFallback: async () => ({ candidates: [mirror], track: mirror, score: 0.99 }),
    onFallbackVerified: async (item) => verified.push(item.encoded),
  });

  player.enqueue(original);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "YouTube blocked" },
  });

  fake.emit("start", { track: { encoded: mirror.encoded } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, []);
  assert.equal(player.nowPlaying().fallbackVerified, false);
  assert.equal(player.nowPlaying().fallbackPending, true);
  assert.match(JSON.stringify(logs), /awaiting stable audio/);

  fake.emit("update", { position: MIN_STABLE_PLAYBACK_POSITION_MS - 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, []);

  fake.position = MIN_STABLE_PLAYBACK_POSITION_MS + 500;
  fake.emit("update", { position: fake.position });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, ["mirror"]);
  assert.equal(player.nowPlaying().fallbackVerified, true);
  assert.equal(player.nowPlaying().fallbackPending, false);
  assert.match(JSON.stringify(logs), /confirmed after stable audio/);
});

test("a mirror that starts then immediately 404s is never cached as good", async () => {
  const original = track("Requested", { encoded: "original" });
  const dead = track("Requested", {
    encoded: "dead-soundcloud",
    sourceName: "soundcloud",
    isFallback: true,
    fallbackScore: 0.99,
  });
  const verified = [];
  const failed = [];
  const { player, fake } = await connectedPlayer({
    resolveFallback: async () => ({ candidates: [dead], track: dead, score: 0.99 }),
    onFallbackVerified: async (item) => verified.push(item.encoded),
    onFallbackFailed: async (item) => failed.push(item.encoded),
  });

  player.enqueue(original);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "YouTube blocked" },
  });
  fake.emit("start", { track: { encoded: dead.encoded } });
  await new Promise((resolve) => setImmediate(resolve));

  await player._handleTrackException({
    track: { encoded: dead.encoded },
    exception: { message: "Invalid status code for soundcloud stream: 404" },
  });

  assert.deepEqual(verified, []);
  assert.deepEqual(failed, ["dead-soundcloud"]);
  assert.equal(dead.fallbackVerified, false);
});

test("exception and loadFailed for the same attempt share one recovery owner", async () => {
  const original = track("Requested", { encoded: "original" });
  let searches = 0;
  const { player, logs } = await connectedPlayer({
    resolveFallback: async () => {
      searches += 1;
      return { candidates: [], track: null, attempts: [], rejections: [] };
    },
  });

  player.enqueue(original);
  await player.playNext();
  await Promise.all([
    player._handleTrackException({
      track: { encoded: original.encoded },
      exception: { message: "provider exception" },
    }),
    player._handleTrackEnd({
      reason: "loadFailed",
      track: { encoded: original.encoded },
    }),
  ]);

  assert.equal(searches, 1);
  const text = JSON.stringify(logs);
  assert.equal((text.match(/No strict playable mirror remained/g) || []).length, 1);
  assert.match(text, /Ignoring duplicate playback failure event/);
});

test("production uses supported search prefixes and filters SoundCloud previews", () => {
  assert.deepEqual([...PRODUCTION_FALLBACK_PREFIXES], ["scsearch", "ytmsearch", "ytsearch"]);
  assert.equal(PRODUCTION_FALLBACK_PREFIXES.includes("bcsearch"), false);

  const application = fs.readFileSync(path.resolve(__dirname, "..", "application.yml"), "utf8");
  assert.match(application, /soundcloudSearchEnabled:\s*true/);
  assert.match(application, /soundcloudFilterOutPreviewTracks:\s*true/);
});
