"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { GuildPlayer } = require("../src/guild-player");

function track(name) {
  return { title: name, encoded: `encoded-${name}` };
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

async function connectedPlayer() {
  const fake = new FakePlayer();
  const player = new GuildPlayer(new FakeShoukaku(fake), "guild", {
    logger: { log() {}, warn() {}, error() {} },
  });
  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  return { player, fake };
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
