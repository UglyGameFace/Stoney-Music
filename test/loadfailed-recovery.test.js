"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { PlaybackGuildPlayer } = require("../src/playback-guild-player");

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
  }

  async playTrack(payload) {
    this.played.push(payload.track.encoded);
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

async function settleUntil(predicate, attempts = 20) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "condition did not settle before the test timeout");
}

test("an end-only loadFailed event enters mirror recovery before clearing the requested track", async () => {
  const fake = new FakePlayer();
  const logs = [];
  const original = track("Requested Song", { encoded: "blocked-youtube" });
  const mirror = track("Requested Song", {
    encoded: "working-soundcloud",
    sourceName: "soundcloud",
    isFallback: true,
    fallbackScore: 0.99,
  });
  let searches = 0;

  const player = new PlaybackGuildPlayer(new FakeShoukaku(fake), "guild", {
    playbackStartTimeoutMs: 60_000,
    logger: {
      log: (...args) => logs.push(["log", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    resolveFallback: async () => {
      searches += 1;
      return { candidates: [mirror], track: mirror, score: 0.99, attempts: [] };
    },
  });

  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  player.enqueue(original);
  await player.playNext();

  fake.emit("end", {
    reason: "loadFailed",
    track: { encoded: original.encoded },
  });

  await settleUntil(() => player.nowPlaying()?.encoded === mirror.encoded);

  assert.equal(searches, 1);
  assert.equal(player.nowPlaying().encoded, mirror.encoded);
  assert.deepEqual(fake.played, [original.encoded, mirror.encoded]);
  assert.equal(player.queueLength(), 0);
  assert.match(JSON.stringify(logs), /routing directly into mirror recovery/);
  assert.match(JSON.stringify(logs), /Trying strict playback mirror/);
});

test("a stale loadFailed end event cannot erase a replacement already playing", async () => {
  const fake = new FakePlayer();
  const original = track("Requested Song", { encoded: "blocked-youtube" });
  const mirror = track("Requested Song", {
    encoded: "working-soundcloud",
    sourceName: "soundcloud",
    isFallback: true,
  });

  const player = new PlaybackGuildPlayer(new FakeShoukaku(fake), "guild", {
    playbackStartTimeoutMs: 60_000,
    resolveFallback: async () => ({ candidates: [mirror], track: mirror }),
  });

  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  player.enqueue(original);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "blocked" },
  });
  assert.equal(player.nowPlaying().encoded, mirror.encoded);

  fake.emit("end", {
    reason: "loadFailed",
    track: { encoded: original.encoded },
  });
  await settleUntil(() => player.nowPlaying()?.encoded === mirror.encoded);

  assert.equal(player.nowPlaying().encoded, mirror.encoded);
  assert.deepEqual(fake.played, [original.encoded, mirror.encoded]);
});
