"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { GuildPlayer } = require("../src/guild-player");

function track(name, overrides = {}) {
  return {
    title: name,
    author: "Artist",
    uri: "",
    durationMs: 180_000,
    sourceName: "youtube",
    requesterId: "requester",
    encoded: `encoded-${name}`,
    ...overrides,
  };
}

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.volumes = [];
    this.stopCalls = 0;
    this.filters = [];
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

  async setFilters(filters) {
    this.filters.push(filters);
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

async function connectedPlayer(resolveFallback = null) {
  const fake = new FakePlayer();
  const logs = [];
  const player = new GuildPlayer(new FakeShoukaku(fake), "guild", {
    logger: {
      log: (...args) => logs.push(["log", ...args]),
      warn: (...args) => logs.push(["warn", ...args]),
      error: (...args) => logs.push(["error", ...args]),
    },
    resolveFallback,
  });
  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  return { player, fake, logs };
}

test("finished track repeats only when track loop is enabled", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueue(track("one"));
  await player.playNext();
  await player.setLoop("track");
  await player._handleTrackEnd({ reason: "finished" });

  assert.deepEqual(fake.played, ["encoded-one", "encoded-one"]);
  assert.equal(player.nowPlaying().title, "one");
});

test("manual skip advances once and never replays a track-loop item", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two")]);
  await player.playNext();
  await player.setLoop("track");
  await player.skip();
  await player._handleTrackEnd({ reason: "stopped" });

  assert.equal(fake.stopCalls, 1);
  assert.deepEqual(fake.played, ["encoded-one", "encoded-two"]);
  assert.equal(player.nowPlaying().title, "two");
});

test("track exception does not double-advance before loadFailed end", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two"), track("three")]);
  await player.playNext();

  fake.emit("exception", { exception: { message: "decoder failed" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(player.nowPlaying().title, "one");

  await player._handleTrackEnd({ reason: "loadFailed" });
  assert.equal(player.nowPlaying().title, "two");
  assert.deepEqual(fake.played, ["encoded-one", "encoded-two"]);
});

test("blocked YouTube playback is replaced in place without advancing the queue", async () => {
  const original = track("Kodak Black - Closure [Official Music Video]", {
    author: "Kodak Black",
    encoded: "youtube-closure",
  });
  const replacement = track("Kodak Black - Closure", {
    author: "Kodak Black",
    sourceName: "soundcloud",
    uri: "https://soundcloud.com/example/closure",
    encoded: "soundcloud-closure",
    fallbackAttempted: true,
  });
  const next = track("next", { encoded: "youtube-next" });
  let fallbackCalls = 0;
  const { player, fake, logs } = await connectedPlayer(async (failed) => {
    fallbackCalls += 1;
    assert.equal(failed, original);
    return { track: replacement, source: "scsearch", score: 0.98, attempts: [] };
  });

  player.enqueueMany([original, next]);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "All clients failed: sign in to confirm you're not a bot" },
  });

  assert.equal(fallbackCalls, 1);
  assert.equal(player.nowPlaying(), replacement);
  assert.equal(player.queueLength(), 1);
  assert.equal(player.getQueuePreview()[0], next);
  assert.deepEqual(fake.played, ["youtube-closure", "soundcloud-closure"]);
  assert.match(JSON.stringify(logs), /Recovered blocked playback/);

  // Lavalink may still emit the failed YouTube track's terminal event after the
  // replacement starts. It must be recognized as stale and ignored.
  await player._handleTrackEnd({ reason: "loadFailed", track: { encoded: original.encoded } });
  assert.equal(player.nowPlaying(), replacement);
  assert.equal(player.queueLength(), 1);
  assert.deepEqual(fake.played, ["youtube-closure", "soundcloud-closure"]);
});

test("an unavailable fallback lets loadFailed advance exactly once", async () => {
  const original = track("blocked", { encoded: "youtube-blocked" });
  const next = track("next", { encoded: "youtube-next" });
  let fallbackCalls = 0;
  const { player, fake } = await connectedPlayer(async () => {
    fallbackCalls += 1;
    return { track: null, score: 0.2, attempts: [{ source: "scsearch", count: 0 }] };
  });

  player.enqueueMany([original, next]);
  await player.playNext();
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "source blocked" },
  });
  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "duplicate source error" },
  });
  await player._handleTrackEnd({ reason: "loadFailed", track: { encoded: original.encoded } });

  assert.equal(fallbackCalls, 1, "the same failed track must not launch repeated provider searches");
  assert.equal(player.nowPlaying(), next);
  assert.equal(player.queueLength(), 0);
  assert.deepEqual(fake.played, ["youtube-blocked", "youtube-next"]);
});

test("queue loop rotates a finished track to the back", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two")]);
  await player.playNext();
  await player.setLoop("queue");
  await player._handleTrackEnd({ reason: "finished" });

  assert.equal(player.nowPlaying().title, "two");
  assert.deepEqual(player.getQueuePreview().map((item) => item.title), ["one"]);
  assert.deepEqual(fake.played, ["encoded-one", "encoded-two"]);
});

test("stop clears state and a later stopped event cannot restart the queue", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two")]);
  await player.playNext();
  await player.stopAndClear();
  await player._handleTrackEnd({ reason: "stopped" });

  assert.equal(player.nowPlaying(), null);
  assert.equal(player.queueLength(), 0);
  assert.deepEqual(fake.played, ["encoded-one"]);
});

test("a connected player refuses a different voice channel", async () => {
  const { player } = await connectedPlayer();
  await assert.rejects(
    player.connect({ guildId: "guild", voiceChannelId: "different", shardId: 0 }),
    /another voice channel/
  );
});

test("stale end events cannot skip the newly playing track", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two"), track("three")]);
  await player.playNext();
  await player._handleTrackEnd({ reason: "finished", track: { encoded: "encoded-one" } });
  assert.equal(player.nowPlaying().title, "two");

  await player._handleTrackEnd({ reason: "loadFailed", track: { encoded: "encoded-one" } });
  assert.equal(player.nowPlaying().title, "two");
  assert.deepEqual(fake.played, ["encoded-one", "encoded-two"]);
});
