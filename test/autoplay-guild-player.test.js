"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { GuildPlayer } = require("../src/guild-player");

function track(name, overrides = {}) {
  return {
    title: name,
    author: overrides.author || "Seed Artist",
    uri: overrides.uri || `https://example.com/${name}`,
    durationMs: overrides.durationMs || 180_000,
    sourceName: overrides.sourceName || "youtube",
    requesterId: overrides.requesterId || "requester",
    encoded: overrides.encoded || `encoded-${name}`,
    autoplay: Boolean(overrides.autoplay),
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

  async setGlobalVolume(value) {
    this.volumes.push(value);
  }

  async stopTrack() {
    this.stopCalls += 1;
  }

  async setFilters() {}
}

class FakeShoukaku {
  constructor(player) {
    this.player = player;
  }

  async joinVoiceChannel() {
    return this.player;
  }
}

async function connectedPlayer(resolveAutoplay) {
  const fake = new FakePlayer();
  const logs = [];
  const player = new GuildPlayer(new FakeShoukaku(fake), "guild", {
    resolveAutoplay,
    logger: {
      log: (...args) => logs.push(["log", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
  });
  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  return { player, fake, logs };
}

test("autoplay starts a related recommendation and prefetches the following one", async () => {
  const seed = track("Seed Song");
  const recommended = track("Related Song", {
    author: "Related Artist",
    encoded: "encoded-related",
    autoplay: true,
  });
  let calls = 0;
  const { player, fake, logs } = await connectedPlayer(async (actualSeed) => {
    calls += 1;
    assert.equal(actualSeed.title, "Seed Song");
    return { track: recommended, recommendationProvider: "listenbrainz-radio", score: 0.91 };
  });

  player.enqueue(seed);
  await player.playNext();
  await player.setAutoplay(true);
  await player._handleTrackEnd({ reason: "finished", track: { encoded: seed.encoded } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls, 2, "the second lookup preloads the track after the active recommendation");
  assert.equal(player.nowPlaying(), recommended);
  assert.equal(player.autoplayStatus(), true);
  assert.deepEqual(fake.played, ["encoded-Seed Song", "encoded-related"]);
  assert.match(JSON.stringify(logs), /Autoplay selected a related track/);
});

test("a human track queued while recommendation prefetch is running always wins", async () => {
  const seed = track("Seed Song");
  const manual = track("Human Queue Song", { encoded: "encoded-human" });
  const recommended = track("Related Song", { encoded: "encoded-related", autoplay: true });
  let releaseRecommendation;
  const recommendation = new Promise((resolve) => {
    releaseRecommendation = () =>
      resolve({ track: recommended, recommendationProvider: "listenbrainz-radio", score: 0.9 });
  });
  const { player, fake } = await connectedPlayer(async () => recommendation);

  player.enqueue(seed);
  await player.playNext();
  await player.setAutoplay(true);
  await new Promise((resolve) => setImmediate(resolve));
  player.enqueue(manual);
  releaseRecommendation();
  await player._handleTrackEnd({ reason: "finished", track: { encoded: seed.encoded } });

  assert.equal(player.nowPlaying(), manual);
  assert.deepEqual(fake.played, ["encoded-Seed Song", "encoded-human"]);
});

test("the latest human-requested song becomes the station seed", async () => {
  const first = track("First Request", { author: "First Artist" });
  const second = track("Second Request", { author: "Second Artist" });
  const seenSeeds = [];
  const { player } = await connectedPlayer(async (seed) => {
    seenSeeds.push(`${seed.author} - ${seed.title}`);
    return null;
  });

  player.enqueueMany([first, second]);
  await player.playNext();
  await player.setAutoplay(true);
  await player._handleTrackEnd({ reason: "finished", track: { encoded: first.encoded } });
  await player._handleTrackEnd({ reason: "finished", track: { encoded: second.encoded } });

  assert.equal(seenSeeds.at(-1), "Second Artist - Second Request");
});

test("stop clears the queue and disables autoplay so it cannot resurrect playback", async () => {
  const seed = track("Seed Song");
  let releaseRecommendation;
  const pending = new Promise((resolve) => {
    releaseRecommendation = () => resolve({ track: track("Ghost", { autoplay: true }) });
  });
  const { player, fake } = await connectedPlayer(async () => pending);

  player.enqueue(seed);
  await player.playNext();
  await player.setAutoplay(true);
  await new Promise((resolve) => setImmediate(resolve));
  await player.stopAndClear();
  releaseRecommendation();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(player.autoplayStatus(), false);
  assert.equal(player.nowPlaying(), null);
  assert.equal(player.queueLength(), 0);
  assert.deepEqual(fake.played, ["encoded-Seed Song"]);
});

test("manual skip can continue into autoplay when no human queue remains", async () => {
  const seed = track("Seed Song");
  const recommended = track("Related Song", { encoded: "encoded-related", autoplay: true });
  const { player } = await connectedPlayer(async () => ({ track: recommended, score: 0.8 }));

  player.enqueue(seed);
  await player.playNext();
  await player.setAutoplay(true);
  await player.skip();
  await player._handleTrackEnd({ reason: "stopped", track: { encoded: seed.encoded } });

  assert.equal(player.nowPlaying(), recommended);
});
