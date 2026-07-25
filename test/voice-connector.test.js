"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  StableDiscordJSConnector,
  VOICE_SERVER_UPDATE,
  VOICE_STATE_UPDATE,
} = require("../src/voice-connector");

function createHarness() {
  const events = [];
  const logs = [];
  const guildId = "123";
  const connection = {
    sessionId: null,
    setStateUpdate(data) {
      this.sessionId = data.session_id || null;
      events.push(["state", data.session_id || null, data.channel_id || null]);
    },
    setServerUpdate(data) {
      events.push(["server", data.endpoint || null, this.sessionId]);
    },
  };

  const client = {
    once() {},
    on() {},
    user: { id: "bot-user" },
    ws: { shards: new Map() },
  };
  const connector = new StableDiscordJSConnector(client, {
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  });
  connector.set({
    id: "bot-user",
    connections: new Map([[guildId, connection]]),
  });

  return { connector, connection, events, guildId, logs };
}

function startupHarness({ ready }) {
  const handlers = new Map();
  const addedNodes = [];
  const logs = [];
  const client = {
    isReady: () => ready,
    once(event, handler) {
      handlers.set(`once:${event}`, handler);
    },
    on(event, handler) {
      handlers.set(`on:${event}`, handler);
    },
    user: { id: "bot-user" },
    ws: { shards: new Map() },
  };
  const manager = {
    id: null,
    connections: new Map(),
    addNode(node) {
      addedNodes.push(node);
    },
  };
  const connector = new StableDiscordJSConnector(client, {
    logger: {
      log: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
  });
  connector.set(manager);

  return { addedNodes, client, connector, handlers, logs, manager };
}

function nodeOptions() {
  return [{ name: "main", url: "127.0.0.1:2333", auth: "password", secure: false }];
}

function statePacket(guildId, overrides = {}) {
  return {
    t: VOICE_STATE_UPDATE,
    d: {
      guild_id: guildId,
      user_id: "bot-user",
      channel_id: "voice-channel",
      session_id: "session-abc",
      self_deaf: true,
      self_mute: false,
      ...overrides,
    },
  };
}

function serverPacket(guildId, overrides = {}) {
  return {
    t: VOICE_SERVER_UPDATE,
    d: {
      guild_id: guildId,
      endpoint: "us-east.discord.media:443",
      token: "voice-token",
      ...overrides,
    },
  };
}

test("connector initializes immediately when Discord clientReady already fired", () => {
  const { addedNodes, connector, handlers, logs, manager } = startupHarness({ ready: true });

  connector.listen(nodeOptions());

  assert.equal(manager.id, "bot-user");
  assert.equal(addedNodes.length, 1);
  assert.equal(typeof handlers.get("on:raw"), "function");
  assert.equal(handlers.has("once:clientReady"), false);
  assert.match(logs.join("\n"), /already-ready Discord client/);
});

test("connector waits for clientReady when Discord is not ready yet", () => {
  const { addedNodes, connector, handlers, manager } = startupHarness({ ready: false });

  connector.listen(nodeOptions());

  assert.equal(manager.id, null);
  assert.equal(addedNodes.length, 0);
  assert.equal(typeof handlers.get("on:raw"), "function");
  assert.equal(typeof handlers.get("once:clientReady"), "function");

  handlers.get("once:clientReady")();
  assert.equal(manager.id, "bot-user");
  assert.equal(addedNodes.length, 1);
});

test("server-first Discord voice packets are buffered until the session ID arrives", () => {
  const { connector, events, guildId, logs } = createHarness();

  connector.raw(serverPacket(guildId));
  assert.deepEqual(events, []);
  assert.equal(connector.pendingServerUpdates.has(guildId), true);

  connector.raw(statePacket(guildId));
  assert.deepEqual(events, [
    ["state", "session-abc", "voice-channel"],
    ["server", "us-east.discord.media:443", "session-abc"],
  ]);
  assert.equal(connector.pendingServerUpdates.has(guildId), false);
  assert.match(logs.join("\n"), /buffering it until/);
  assert.match(logs.join("\n"), /Completed buffered Discord voice handshake/);
});

test("state-first Discord voice packets pass through immediately", () => {
  const { connector, events, guildId } = createHarness();

  connector.raw(statePacket(guildId));
  connector.raw(serverPacket(guildId));

  assert.deepEqual(events, [
    ["state", "session-abc", "voice-channel"],
    ["server", "us-east.discord.media:443", "session-abc"],
  ]);
});

test("voice updates for another user are ignored", () => {
  const { connector, events, guildId } = createHarness();
  connector.raw(statePacket(guildId, { user_id: "someone-else" }));
  assert.deepEqual(events, []);
});

test("disconnect state clears a buffered server update", () => {
  const { connector, events, guildId } = createHarness();

  connector.raw(serverPacket(guildId));
  connector.raw(statePacket(guildId, { channel_id: null, session_id: null }));

  assert.deepEqual(events, [["state", null, null]]);
  assert.equal(connector.pendingServerUpdates.has(guildId), false);
});

test("missing voice endpoint is reported immediately instead of being buffered", () => {
  const { connector, events, guildId } = createHarness();
  connector.raw(serverPacket(guildId, { endpoint: null }));
  assert.deepEqual(events, [["server", null, null]]);
});
