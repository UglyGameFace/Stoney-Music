"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, Events, PermissionFlagsBits } = require("discord.js");

const {
  SETUP_BUTTON_ID,
  SETUP_CHANNEL_SELECT_ID,
  SETUP_PANEL_VERSION,
  buildSetupPanel,
  chooseSetupChannel,
  formatCommandMentions,
  handleSetupPanelInteraction,
  postSetupPanels,
} = require("../src/setup-panel");

function usableChannel(id, name = "music") {
  const sent = [];
  return {
    id,
    name,
    type: ChannelType.GuildText,
    rawPosition: 0,
    sent,
    async send(payload) {
      sent.push(payload);
      return { id: `message-${id}-${sent.length}` };
    },
    permissionsFor() {
      return {
        has(required) {
          return required.includes(PermissionFlagsBits.ViewChannel) &&
            required.includes(PermissionFlagsBits.SendMessages) &&
            required.includes(PermissionFlagsBits.EmbedLinks);
        },
      };
    },
  };
}

function fakeGuild(id, channels, systemChannel = null) {
  return {
    id,
    name: `Server ${id}`,
    systemChannel,
    members: { me: { id: "bot" } },
    channels: {
      cache: new Map(channels.map((channel) => [channel.id, channel])),
      async fetch(channelId) {
        return this.cache.get(channelId) || null;
      },
    },
    commands: { fetch: async () => new Map() },
    client: null,
  };
}

function fakeClient(guilds) {
  const handlers = new Map();
  const globalCommands = new Map([
    ["1", { id: "1", name: "setup" }],
    ["2", { id: "2", name: "play" }],
  ]);
  const client = {
    guilds: { cache: new Map(guilds.map((guild) => [guild.id, guild])) },
    application: { commands: { fetch: async () => globalCommands } },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  for (const guild of guilds) guild.client = client;
  return { client, handlers };
}

function memoryConfigStore() {
  const states = new Map();
  return {
    async load() {},
    get(guildId) {
      return { ...(states.get(guildId) || {}) };
    },
    hasSavedSetup(guildId) {
      return Boolean(states.get(guildId)?.musicTextChannelId);
    },
    async set(guildId, patch) {
      const next = { ...(states.get(guildId) || {}), ...patch };
      states.set(guildId, next);
      return { ...next };
    },
    states,
  };
}

test("recovery panel exposes a channel picker and is explicitly server-scoped", () => {
  const panel = buildSetupPanel({ play: "111", setup: "222" });
  assert.equal(panel.components.length, 2);
  assert.equal(panel.components[0].components[0].data.custom_id, SETUP_CHANNEL_SELECT_ID);
  assert.equal(panel.components[1].components[0].data.custom_id, SETUP_BUTTON_ID);
  const json = JSON.stringify(panel);
  assert.match(json, /Every server has its own saved setup/);
  assert.match(json, /<\/play:111>/);
  assert.doesNotMatch(json, /Verified|Resident/);
});

test("formatCommandMentions falls back to readable slash names without IDs", () => {
  const text = formatCommandMentions({ play: "111" });
  assert.match(text, /<\/play:111>/);
  assert.match(text, /\/queue/);
});

test("setup channel selection prefers the recorded usable panel channel", () => {
  const preferred = usableChannel("456", "commands");
  const other = usableChannel("789", "general");
  const guild = fakeGuild("123", [other, preferred], other);
  assert.equal(chooseSetupChannel(guild, preferred.id), preferred);
});

test("startup posts one current setup panel independently in every unconfigured server", async () => {
  const firstChannel = usableChannel("111", "general");
  const secondChannel = usableChannel("222", "welcome");
  const firstGuild = fakeGuild("guild-a", [firstChannel], firstChannel);
  const secondGuild = fakeGuild("guild-b", [secondChannel], secondChannel);
  const { client, handlers } = fakeClient([firstGuild, secondGuild]);
  const store = memoryConfigStore();

  await postSetupPanels({ client, configStore: store, logger: { log() {}, error() {} } });

  assert.equal(firstChannel.sent.length, 1);
  assert.equal(secondChannel.sent.length, 1);
  assert.equal(store.get(firstGuild.id).setupPanelVersion, SETUP_PANEL_VERSION);
  assert.equal(store.get(secondGuild.id).setupPanelVersion, SETUP_PANEL_VERSION);
  assert.equal(typeof handlers.get(Events.GuildCreate), "function");

  await postSetupPanels({ client, configStore: store, logger: { log() {}, error() {} } });
  assert.equal(firstChannel.sent.length, 1);
  assert.equal(secondChannel.sent.length, 1);
});

test("joining a new server while online starts setup for that server only", async () => {
  const existingChannel = usableChannel("111", "general");
  const existingGuild = fakeGuild("guild-a", [existingChannel], existingChannel);
  const { client, handlers } = fakeClient([existingGuild]);
  const store = memoryConfigStore();
  await store.set(existingGuild.id, { musicTextChannelId: existingChannel.id });

  await postSetupPanels({ client, configStore: store, logger: { log() {}, error() {} } });
  const joinedChannel = usableChannel("222", "welcome");
  const joinedGuild = fakeGuild("guild-b", [joinedChannel], joinedChannel);
  joinedGuild.client = client;
  client.guilds.cache.set(joinedGuild.id, joinedGuild);

  await handlers.get(Events.GuildCreate)(joinedGuild);
  assert.equal(existingChannel.sent.length, 0);
  assert.equal(joinedChannel.sent.length, 1);
  assert.equal(store.get(joinedGuild.id).setupPanelVersion, SETUP_PANEL_VERSION);
});

test("an old panel version is replaced once with the current picker", async () => {
  const channel = usableChannel("111", "general");
  const guild = fakeGuild("guild-a", [channel], channel);
  const { client } = fakeClient([guild]);
  const store = memoryConfigStore();
  await store.set(guild.id, {
    setupPanelChannelId: channel.id,
    setupPanelMessageId: "old-message",
    setupPanelVersion: "1",
  });

  await postSetupPanels({ client, configStore: store, logger: { log() {}, error() {} } });
  assert.equal(channel.sent.length, 1);
  assert.equal(store.get(guild.id).setupPanelVersion, SETUP_PANEL_VERSION);
  assert.notEqual(store.get(guild.id).setupPanelMessageId, "old-message");
});

test("channel picker saves only the selected server's channel with no role gate", async () => {
  const panelChannel = usableChannel("456", "general");
  const selectedChannel = usableChannel("789", "bot-commands");
  const guild = fakeGuild("123", [panelChannel, selectedChannel], panelChannel);
  const { client } = fakeClient([guild]);
  guild.client = client;
  const writes = [];
  let updatePayload = null;
  const interaction = {
    customId: SETUP_CHANNEL_SELECT_ID,
    values: [selectedChannel.id],
    guild,
    guildId: guild.id,
    channel: panelChannel,
    channelId: panelChannel.id,
    message: { id: "panel-message" },
    isButton: () => false,
    isChannelSelectMenu: () => true,
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    update: async (payload) => {
      updatePayload = payload;
    },
  };
  const configStore = {
    get: () => ({
      setupPanelMessageId: "panel-message",
      setupPanelVersion: SETUP_PANEL_VERSION,
    }),
    async set(guildId, patch) {
      writes.push({ guildId, patch });
      return { ...patch };
    },
  };

  const handled = await handleSetupPanelInteraction(interaction, {
    configStore,
    commandIds: { play: "111" },
    logger: { log() {} },
  });

  assert.equal(handled, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].guildId, guild.id);
  assert.equal(writes[0].patch.musicTextChannelId, selectedChannel.id);
  assert.equal(writes[0].patch.roleVerifiedId, null);
  assert.equal(writes[0].patch.roleResidentId, null);
  assert.equal(writes[0].patch.setupPanelVersion, SETUP_PANEL_VERSION);
  assert.deepEqual(updatePayload.components, []);
  assert.equal(selectedChannel.sent.length, 1);
});

test("stale or old-version recovery cards cannot overwrite setup", async () => {
  const channel = usableChannel("456", "general");
  const guild = fakeGuild("123", [channel], channel);
  let replyPayload = null;
  const interaction = {
    customId: SETUP_BUTTON_ID,
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    message: { id: "old-message" },
    isButton: () => true,
    isChannelSelectMenu: () => false,
    inGuild: () => true,
    memberPermissions: { has: () => true },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  const handled = await handleSetupPanelInteraction(interaction, {
    configStore: {
      get: () => ({ setupPanelMessageId: "new-message", setupPanelVersion: SETUP_PANEL_VERSION }),
      set: async () => assert.fail("stale panel must not save"),
    },
    logger: { log() {} },
  });

  assert.equal(handled, true);
  assert.match(replyPayload.content, /old Stoney Music setup card/);
});

test("recovery controls refuse members without Manage Server", async () => {
  const channel = usableChannel("456");
  const guild = fakeGuild("123", [channel], channel);
  let replyPayload = null;
  const interaction = {
    customId: SETUP_BUTTON_ID,
    guild,
    guildId: guild.id,
    channel,
    isButton: () => true,
    isChannelSelectMenu: () => false,
    inGuild: () => true,
    memberPermissions: { has: () => false },
    reply: async (payload) => {
      replyPayload = payload;
    },
  };

  const handled = await handleSetupPanelInteraction(interaction, {
    configStore: { set: async () => assert.fail("should not save") },
    logger: { log() {} },
  });

  assert.equal(handled, true);
  assert.match(replyPayload.content, /Manage Server/);
});
