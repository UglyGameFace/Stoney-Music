"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  IDS,
  PlayerControllerManager,
  buildPlayerPayload,
  buildPositionModal,
  buildProgressBar,
  buildQueuePayload,
  formatDuration,
  pageFromCustomId,
} = require("../src/player-controller");

function track(name, overrides = {}) {
  return {
    title: name,
    author: overrides.author || "Artist",
    uri: overrides.uri || `https://example.com/${name}`,
    artworkUrl: overrides.artworkUrl || "https://example.com/art.png",
    durationMs: overrides.durationMs ?? 180_000,
    sourceName: overrides.sourceName || "soundcloud",
    requesterId: overrides.requesterId || "629459300854661120",
    encoded: overrides.encoded || `encoded-${name}`,
    isStream: Boolean(overrides.isStream),
    autoplay: Boolean(overrides.autoplay),
    ...overrides,
  };
}

class FakeGuildPlayer extends EventEmitter {
  constructor(state = {}) {
    super();
    this.guildId = "guild";
    this.voiceChannelId = "voice";
    this.state = {
      connected: true,
      voiceChannelId: "voice",
      current: track("Current Song"),
      queue: [track("Next One"), track("Next Two")],
      history: [track("Previous Song")],
      positionMs: 45_000,
      paused: false,
      volume: 100,
      muted: false,
      loopMode: "off",
      filterPreset: "clear",
      autoplayEnabled: true,
      ...state,
    };
    this.calls = [];
  }

  snapshot() {
    return { ...this.state, queue: [...this.state.queue], history: [...this.state.history] };
  }

  isConnected() {
    return this.state.connected;
  }

  autoplayStatus() {
    return this.state.autoplayEnabled;
  }

  queueLength() {
    return this.state.queue.length;
  }

  async togglePaused() {
    this.calls.push("togglePaused");
    this.state.paused = !this.state.paused;
    return this.state.paused;
  }

  async seekBy(value) {
    this.calls.push(["seekBy", value]);
    this.state.positionMs += value;
    return this.state.positionMs;
  }

  async skip() {
    this.calls.push("skip");
    return true;
  }

  async previous() {
    this.calls.push("previous");
    return this.state.history.at(-1) || null;
  }

  async replay() {
    this.calls.push("replay");
    return true;
  }

  shuffle() {
    this.calls.push("shuffle");
    return this.state.queue.length;
  }

  async cycleLoop() {
    this.calls.push("cycleLoop");
    this.state.loopMode = "track";
    return "track";
  }

  async setAutoplay(value) {
    this.calls.push(["setAutoplay", value]);
    this.state.autoplayEnabled = value;
    return value;
  }

  async stopAndClear() {
    this.calls.push("stopAndClear");
    this.state.current = null;
    this.state.queue = [];
  }

  async adjustVolume(value) {
    this.calls.push(["adjustVolume", value]);
    this.state.volume += value;
    return this.state.volume;
  }

  async toggleMute() {
    this.calls.push("toggleMute");
    this.state.muted = !this.state.muted;
    this.state.volume = this.state.muted ? 0 : 100;
    return this.state.volume;
  }

  async disconnect() {
    this.calls.push("disconnect");
    this.state.connected = false;
  }

  async setFilterPreset(value) {
    this.calls.push(["filter", value]);
    this.state.filterPreset = value;
  }

  removeQueueTrack(position) {
    this.calls.push(["remove", position]);
    return this.state.queue.splice(position - 1, 1)[0];
  }

  moveQueueTrack(position, destination) {
    this.calls.push(["move", position, destination]);
    const [item] = this.state.queue.splice(position - 1, 1);
    this.state.queue.splice(destination - 1, 0, item);
    return item;
  }

  clearQueue() {
    this.calls.push("clearQueue");
    const count = this.state.queue.length;
    this.state.queue = [];
    return count;
  }
}

function fakeInteraction(overrides = {}) {
  const calls = [];
  const interaction = {
    customId: IDS.pause,
    guildId: "guild",
    message: { id: "message" },
    member: { voice: { channelId: "voice" } },
    values: [],
    deferred: false,
    replied: false,
    inGuild: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    async deferUpdate() {
      this.deferred = true;
      calls.push(["deferUpdate"]);
    },
    async reply(payload) {
      this.replied = true;
      calls.push(["reply", payload]);
      return payload;
    },
    async followUp(payload) {
      calls.push(["followUp", payload]);
      return payload;
    },
    async update(payload) {
      calls.push(["update", payload]);
      return payload;
    },
    async showModal(payload) {
      calls.push(["showModal", payload]);
      return payload;
    },
    ...overrides,
  };
  return { interaction, calls };
}

function controllerHarness(guildPlayer = new FakeGuildPlayer()) {
  const manager = new PlayerControllerManager({
    client: { channels: { fetch: async () => null } },
    players: { peek: () => guildPlayer },
    logger: { warn() {}, error() {} },
  });
  manager.registerMessage("guild", { id: "message", channelId: "channel" });
  const refreshes = [];
  manager.refresh = async (guildId, options) => {
    refreshes.push({ guildId, options });
    return null;
  };
  return { manager, guildPlayer, refreshes };
}

test("duration and progress rendering support regular and live tracks", () => {
  assert.equal(formatDuration(90_000), "1:30");
  assert.equal(formatDuration(3_723_000), "1:02:03");
  assert.match(buildProgressBar(45_000, 180_000), /0:45 \/ 3:00/);
  assert.equal(buildProgressBar(0, 0, { stream: true }), "🔴 LIVE");
});

test("player payload contains persistent transport, playback, utility, and filter rows", () => {
  const player = new FakeGuildPlayer({
    current: track("Recommended Song", {
      autoplay: true,
      autoplaySeedAuthor: "Seed Artist",
      autoplaySeedTitle: "Seed Song",
    }),
  });
  const payload = buildPlayerPayload(player);
  assert.equal(payload.components.length, 4);
  const json = JSON.stringify(payload);
  assert.match(json, /Autoplay: On/);
  assert.match(json, /Recommended from Seed Artist/);
  assert.match(json, /Previous/);
  assert.match(json, /Disconnect/);
  assert.match(json, /8D Rotation/);
});

test("live streams disable seek and replay controls", () => {
  const payload = buildPlayerPayload(new FakeGuildPlayer({ current: track("Live", { isStream: true }) }));
  const components = payload.components.map((row) => row.toJSON());
  const buttons = components.flatMap((row) => row.components || []);
  const rewind = buttons.find((button) => button.custom_id === IDS.rewind);
  const forward = buttons.find((button) => button.custom_id === IDS.forward);
  const replay = buttons.find((button) => button.custom_id === IDS.replay);
  assert.equal(rewind.disabled, true);
  assert.equal(forward.disabled, true);
  assert.equal(replay.disabled, true);
});

test("queue payload paginates ten tracks and stays compatible with interaction.update", () => {
  const queue = Array.from({ length: 23 }, (_, index) => track(`Song ${index + 1}`));
  const payload = buildQueuePayload(new FakeGuildPlayer({ queue }), 1);
  const json = JSON.stringify(payload);
  assert.match(json, /Song 11/);
  assert.match(json, /Song 20/);
  assert.doesNotMatch(json, /Song 21/);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, "flags"), false);
  assert.equal(pageFromCustomId(`${IDS.queuePage}:2`), 2);
});

test("queue edit modals request the correct fields", () => {
  const remove = buildPositionModal("remove").toJSON();
  const move = buildPositionModal("move").toJSON();
  assert.equal(remove.components.length, 1);
  assert.equal(move.components.length, 2);
  assert.equal(remove.custom_id, IDS.modalRemove);
  assert.equal(move.custom_id, IDS.modalMove);
});

test("canonical pause button dispatches to the player and refreshes the panel", async () => {
  const { manager, guildPlayer, refreshes } = controllerHarness();
  const { interaction } = fakeInteraction();
  assert.equal(await manager.handle(interaction), true);
  assert.deepEqual(guildPlayer.calls, ["togglePaused"]);
  assert.equal(refreshes.length, 1);
  assert.match(refreshes[0].options.notice, /paused/i);
});

test("members outside the bot voice channel cannot use player controls", async () => {
  const { manager, guildPlayer } = controllerHarness();
  const { interaction, calls } = fakeInteraction({ member: { voice: { channelId: "different" } } });
  assert.equal(await manager.handle(interaction), true);
  assert.deepEqual(guildPlayer.calls, []);
  assert.match(calls[0][1].content, /same voice channel/i);
});

test("old duplicate player panels are rejected", async () => {
  const { manager, guildPlayer } = controllerHarness();
  const { interaction, calls } = fakeInteraction({ message: { id: "old-message" } });
  assert.equal(await manager.handle(interaction), true);
  assert.deepEqual(guildPlayer.calls, []);
  assert.match(calls[0][1].content, /old player panel/i);
});

test("filter menu and queue button use persistent global handlers", async () => {
  const { manager, guildPlayer } = controllerHarness();
  const filter = fakeInteraction({
    customId: IDS.filter,
    values: ["bassboost"],
    isStringSelectMenu: () => true,
  });
  await manager.handle(filter.interaction);
  assert.deepEqual(guildPlayer.calls[0], ["filter", "bassboost"]);

  const queue = fakeInteraction({ customId: IDS.queue });
  await manager.handle(queue.interaction);
  assert.equal(queue.calls[0][0], "reply");
  assert.equal(queue.calls[0][1].flags, 64);
});
