"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { GuildPlayer } = require("../src/guild-player");

function track(name, overrides = {}) {
  return {
    title: name,
    author: overrides.author || "Artist",
    uri: overrides.uri || `https://example.com/${name}`,
    durationMs: overrides.durationMs ?? 180_000,
    sourceName: overrides.sourceName || "youtube",
    requesterId: overrides.requesterId || "user",
    encoded: overrides.encoded || `encoded-${name}`,
    isStream: Boolean(overrides.isStream),
    autoplay: Boolean(overrides.autoplay),
    ...overrides,
  };
}

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.volumes = [];
    this.paused = false;
    this.position = 0;
    this.stopCalls = 0;
    this.filters = [];
    this.clearFilterCalls = 0;
  }

  async playTrack(payload) {
    this.played.push(payload.track.encoded);
    this.position = 0;
    this.paused = false;
  }

  async setGlobalVolume(value) {
    this.volumes.push(value);
  }

  async stopTrack() {
    this.stopCalls += 1;
  }

  async setPaused(value) {
    this.paused = value;
  }

  async seekTo(value) {
    this.position = value;
  }

  async setFilters(value) {
    this.filters.push(value);
  }

  async clearFilters() {
    this.clearFilterCalls += 1;
  }
}

class FakeShoukaku {
  constructor(player) {
    this.player = player;
    this.leaveCalls = [];
  }

  async joinVoiceChannel() {
    return this.player;
  }

  async leaveVoiceChannel(guildId) {
    this.leaveCalls.push(guildId);
  }
}

async function connectedPlayer() {
  const fake = new FakePlayer();
  const shoukaku = new FakeShoukaku(fake);
  const player = new GuildPlayer(shoukaku, "guild", { logger: { log() {}, warn() {}, error() {} } });
  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  return { player, fake, shoukaku };
}

test("pause, resume, relative seek, and replay update the real player state", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueue(track("one", { durationMs: 200_000 }));
  await player.playNext();

  await player.setPaused(true);
  assert.equal(fake.paused, true);
  await player.togglePaused();
  assert.equal(fake.paused, false);

  fake.position = 50_000;
  assert.equal(await player.seekBy(10_000), 60_000);
  assert.equal(fake.position, 60_000);
  assert.equal(await player.seekBy(-70_000), 0);
  assert.equal(fake.position, 0);

  fake.position = 100_000;
  await player.setPaused(true);
  assert.equal(await player.replay(), true);
  assert.equal(fake.position, 0);
  assert.equal(fake.paused, false);
});

test("seek clamps to track duration and rejects live streams", async () => {
  const { player, fake } = await connectedPlayer();
  player.enqueue(track("one", { durationMs: 100_000 }));
  await player.playNext();
  assert.equal(await player.seekTo(500_000), 99_750);
  assert.equal(fake.position, 99_750);

  await player.stopAndClear();
  player.enqueue(track("live", { isStream: true }));
  await player.playNext();
  await assert.rejects(player.seekTo(10_000), /Live streams/);
});

test("previous replaces the current track and puts that current track at the front of the queue", async () => {
  const { player, fake } = await connectedPlayer();
  const one = track("one");
  const two = track("two");
  player.enqueueMany([one, two]);
  await player.playNext();
  await player._handleTrackEnd({ reason: "finished", track: { encoded: one.encoded } });
  assert.equal(player.nowPlaying(), two);

  const previous = await player.previous();
  assert.equal(previous, one);
  assert.equal(player.nowPlaying(), one);
  assert.equal(player.getQueuePreview()[0], two);
  assert.deepEqual(fake.played, ["encoded-one", "encoded-two", "encoded-one"]);

  await player._handleTrackEnd({ reason: "replaced", track: { encoded: two.encoded } });
  assert.equal(player.nowPlaying(), one);
});

test("shuffle is deterministic with an injected random function", async () => {
  const { player } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two"), track("three"), track("four")]);
  const values = [0.1, 0.9, 0.2];
  let index = 0;
  const count = player.shuffle(() => values[index++]);
  assert.equal(count, 4);
  assert.deepEqual(player.getQueuePreview().map((item) => item.title), ["two", "three", "four", "one"]);
});

test("queue remove, move, and clear use one-based positions", async () => {
  const { player } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two"), track("three")]);
  assert.equal(player.removeQueueTrack(2).title, "two");
  assert.deepEqual(player.getQueuePreview().map((item) => item.title), ["one", "three"]);

  assert.equal(player.moveQueueTrack(2, 1).title, "three");
  assert.deepEqual(player.getQueuePreview().map((item) => item.title), ["three", "one"]);
  assert.equal(player.clearQueue(), 2);
  assert.equal(player.queueLength(), 0);
  assert.throws(() => player.removeQueueTrack(1), /out of range/);
});

test("volume adjustment, mute restore, and loop cycling retain state", async () => {
  const { player, fake } = await connectedPlayer();
  assert.equal(await player.setVolume(140), 140);
  assert.equal(await player.adjustVolume(100), 200);
  assert.equal(await player.toggleMute(), 0);
  assert.equal(await player.toggleMute(), 200);
  assert.deepEqual(fake.volumes.slice(-4), [140, 200, 0, 200]);

  assert.equal(await player.cycleLoop(), "track");
  assert.equal(await player.cycleLoop(), "queue");
  assert.equal(await player.cycleLoop(), "off");
});

test("advanced filters apply and clear through Lavalink", async () => {
  const { player, fake } = await connectedPlayer();
  assert.equal(await player.setFilterPreset("karaoke"), "karaoke");
  assert.equal(fake.filters.at(-1).karaoke.level, 1);
  assert.equal(await player.setFilterPreset("rotation"), "rotation");
  assert.equal(fake.filters.at(-1).rotation.rotationHz, 0.2);
  assert.equal(await player.setFilterPreset("clear"), "clear");
  assert.equal(fake.clearFilterCalls, 1);
  assert.equal(player.snapshot().filterPreset, "clear");
});

test("disconnect clears every active playback state and leaves voice", async () => {
  const { player, shoukaku } = await connectedPlayer();
  player.enqueueMany([track("one"), track("two")]);
  await player.playNext();
  await player.setAutoplay(true);

  assert.equal(await player.disconnect(), true);
  assert.equal(player.isConnected(), false);
  assert.equal(player.nowPlaying(), null);
  assert.equal(player.queueLength(), 0);
  assert.equal(player.autoplayStatus(), false);
  assert.deepEqual(shoukaku.leaveCalls, ["guild"]);
});

test("state snapshots and notifications expose controller-ready state", async () => {
  const { player, fake } = await connectedPlayer();
  const reasons = [];
  player.on("stateChange", (_snapshot, reason) => reasons.push(reason));
  player.enqueue(track("one"));
  await player.playNext();
  fake.position = 42_000;
  await player.setPaused(true);

  const snapshot = player.snapshot();
  assert.equal(snapshot.current.title, "one");
  assert.equal(snapshot.positionMs, 42_000);
  assert.equal(snapshot.paused, true);
  assert.equal(snapshot.connected, true);
  assert.match(reasons.join(","), /queueAdd/);
  assert.match(reasons.join(","), /trackStart/);
  assert.match(reasons.join(","), /pause/);
});
