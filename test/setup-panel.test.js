"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const {
  SETUP_BUTTON_ID,
  SETUP_CHANNEL_SELECT_ID,
  buildSetupPanel,
  chooseSetupChannel,
  formatCommandMentions,
  handleSetupPanelInteraction,
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
      return { id: `message-${id}` };
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

function fakeGuild(channels, systemChannel = null) {
  return {
    id: "123",
    name: "Vibers Paradise",
    systemChannel,
    members: { me: { id: "bot" } },
    channels: {
      cache: new Map(channels.map((channel) => [channel.id, channel])),
      async fetch(id) {
        return this.cache.get(id) || null;
      },
    },
  };
}

test("recovery panel exposes a channel picker, shortcut button, and command mentions", () => {
  const panel = buildSetupPanel({ play: "111", setup: "222" });
  assert.equal(panel.components.length, 2);
  assert.equal(panel.components[0].components[0].data.custom_id, SETUP_CHANNEL_SELECT_ID);
  assert.equal(panel.components[1].components[0].data.custom_id, SETUP_BUTTON_ID);
  const json = JSON.stringify(panel);
  assert.match(json, /Nothing is hard-coded/);
  assert.match(json, /<\/play:111>/);
  assert.doesNotMatch(json, /Verified|Resident/);
});

test("formatCommandMentions falls back to readable slash names without IDs", () => {
  const text = formatCommandMentions({ play: "111" });
  assert.match(text, /<\/play:111>/);
  assert.match(text, /\/queue/);
});

test("setup panel channel selection prefers the recorded usable panel channel", () => {
  const preferred = usableChannel("456", "commands");
  const other = usableChannel("789", "general");
  const guild = fakeGuild([other, preferred], other);
  assert.equal(chooseSetupChannel(guild, preferred.id), preferred);
});

test("recovery channel picker saves the selected channel with no role gate", async () => {
  const panelChannel = usableChannel("456", "general");
  const selectedChannel = usableChannel("789", "bot-commands");
  const guild = fakeGuild([panelChannel, selectedChannel], panelChannel);
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
  assert.equal(writes[0].patch.musicTextChannelId, selectedChannel.id);
  assert.equal(writes[0].patch.roleVerifiedId, null);
  assert.equal(writes[0].patch.roleResidentId, null);
  assert.equal(writes[0].patch.setupPanelMessageId, "panel-message");
  assert.deepEqual(updatePayload.components, []);
  assert.equal(selectedChannel.sent.length, 1);
  assert.match(JSON.stringify(selectedChannel.sent[0]), /<\/play:111>/);
});

test("recovery shortcut button saves the panel channel", async () => {
  const channel = usableChannel("456", "music");
  const guild = fakeGuild([channel], channel);
  const writes = [];
  const interaction = {
    customId: SETUP_BUTTON_ID,
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    message: { id: "panel-message" },
    isButton: () => true,
    isChannelSelectMenu: () => false,
    inGuild: () => true,
    memberPermissions: { has: () => true },
    update: async () => {},
  };
  const configStore = {
    async set(guildId, patch) {
      writes.push({ guildId, patch });
      return { ...patch };
    },
  };

  await handleSetupPanelInteraction(interaction, { configStore, logger: { log() {} } });
  assert.equal(writes[0].patch.musicTextChannelId, channel.id);
  assert.equal(channel.sent.length, 0);
});

test("recovery controls refuse members without Manage Server", async () => {
  const channel = usableChannel("456");
  const guild = fakeGuild([channel], channel);
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
