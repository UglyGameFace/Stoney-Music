"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { ResilientGuildPlayer } = require("../src/resilient-guild-player");

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

async function connectedPlayer({ resolveFallback, onFallbackVerified, onFallbackFailed } = {}) {
  const fake = new FakePlayer();
  const logs = [];
  const player = new ResilientGuildPlayer(new FakeShoukaku(fake), "guild", {
    logger: {
      log: (...args) => logs.push(["log", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    resolveFallback,
    onFallbackVerified,
    onFallbackFailed,
  });
  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  return { player, fake, logs };
}

test("a dead first mirror advances to the second mirror without touching the human queue", async () => {
  const original = track("Requested Song", { encoded: "original-youtube" });
  const first = track("Requested Song", {
    encoded: "dead-soundcloud",
    sourceName: "soundcloud",
    playbackCandidateTitle: "Requested Song",
    fallbackScore: 0.98,
    isFallback: true,
  });
  const second = track("Requested Song", {
    encoded: "working-bandcamp",
    sourceName: "bandcamp",
    playbackCandidateTitle: "Artist - Requested Song",
    fallbackScore: 0.96,
    isFallback: true,
  });
  const humanNext = track("Human Queue Song", { encoded: "human-next" });
  let searches = 0;
  const failed = [];
  const verified = [];
  const { player, fake, logs } = await connectedPlayer({
    resolveFallback: async () => {
      searches += 1;
      return { candidates: [first, second], track: first, score: 0.98, attempts: [] };
    },
    onFallbackFailed: async (item) => failed.push(item.encoded),
    onFallbackVerified: async (item) => verified.push(item.encoded),
  });

  player.enqueueMany([original, humanNext]);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "YouTube requires login" },
  });
  assert.equal(player.nowPlaying().encoded, "dead-soundcloud");
  assert.equal(player.queueLength(), 1);

  await player._handleTrackException({
    track: { encoded: first.encoded },
    exception: { message: "Invalid status code for soundcloud stream: 404" },
  });
  assert.equal(player.nowPlaying().encoded, "working-bandcamp");
  assert.equal(player.queueLength(), 1);
  assert.equal(player.getQueuePreview()[0], humanNext);
  assert.equal(searches, 1, "one strict plan should supply all retry candidates");
  assert.deepEqual(fake.played, ["original-youtube", "dead-soundcloud", "working-bandcamp"]);
  assert.deepEqual(failed, ["dead-soundcloud"]);

  fake.emit("start", { track: { encoded: "working-bandcamp" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, ["working-bandcamp"]);
  assert.equal(player.nowPlaying().fallbackVerified, true);
  assert.match(JSON.stringify(logs), /Playback mirror confirmed by Lavalink/);

  await player._handleTrackEnd({ reason: "loadFailed", track: { encoded: original.encoded } });
  assert.equal(player.nowPlaying().encoded, "working-bandcamp");
  assert.equal(player.queueLength(), 1);
});

test("Spotify and Apple display identity survives provider replacement", async () => {
  for (const sourceType of ["spotify", "apple-music"]) {
    const original = track("Catalog Song", {
      encoded: `blocked-${sourceType}`,
      playbackIdentity: {
        title: "Catalog Song",
        artist: "Catalog Artist",
        album: "Catalog Album",
        artworkUrl: "https://catalog.test/art.jpg",
        durationMs: 200_000,
        durationTrusted: sourceType === "apple-music",
        sourceType,
        requestedQuery: "Catalog Artist - Catalog Song",
      },
    });
    const mirror = track("Catalog Song", {
      title: "Catalog Song",
      author: "Catalog Artist",
      encoded: `mirror-${sourceType}`,
      sourceName: "bandcamp",
      playbackCandidateTitle: "Catalog Artist - Catalog Song",
      playbackCandidateAuthor: "Catalog Artist",
      isFallback: true,
    });
    const { player } = await connectedPlayer({
      resolveFallback: async () => ({ candidates: [mirror], track: mirror, score: 0.99 }),
    });
    player.enqueue(original);
    await player.playNext();
    await player._handleTrackException({
      track: { encoded: original.encoded },
      exception: { message: "provider failed" },
    });

    assert.equal(player.nowPlaying().title, "Catalog Song");
    assert.equal(player.nowPlaying().author, "Catalog Artist");
    assert.equal(player.nowPlaying().playbackIdentity.sourceType, sourceType);
  }
});

test("exhausted fallback plans stop only the failed item and let loadFailed advance once", async () => {
  const original = track("blocked", { encoded: "blocked-original" });
  const humanNext = track("next", { encoded: "human-next" });
  let searches = 0;
  const { player, fake } = await connectedPlayer({
    resolveFallback: async () => {
      searches += 1;
      return { candidates: [], track: null, attempts: [], rejections: [] };
    },
  });

  player.enqueueMany([original, humanNext]);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "blocked" },
  });
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "duplicate blocked event" },
  });
  await player._handleTrackEnd({ reason: "loadFailed", track: { encoded: original.encoded } });

  assert.equal(searches, 1);
  assert.equal(player.nowPlaying(), humanNext);
  assert.deepEqual(fake.played, ["blocked-original", "human-next"]);
});

test("fallback verification ignores a stale start event", async () => {
  const original = track("one", { encoded: "one" });
  const mirror = track("one", {
    encoded: "mirror",
    sourceName: "soundcloud",
    isFallback: true,
  });
  const verified = [];
  const { player, fake } = await connectedPlayer({
    resolveFallback: async () => ({ candidates: [mirror], track: mirror }),
    onFallbackVerified: async (item) => verified.push(item.encoded),
  });
  player.enqueue(original);
  await player.playNext();
  await player._handleTrackException({ track: { encoded: "one" }, exception: { message: "failed" } });

  fake.emit("start", { track: { encoded: "one" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, []);

  fake.emit("start", { track: { encoded: "mirror" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(verified, ["mirror"]);
});
