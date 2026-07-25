"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ChannelType, PermissionFlagsBits } = require("discord.js");

const {
  SETUP_BUTTON_ID,
  buildSetupPanel,
  chooseSetupChannel,
  handleSetupPanelInteraction,
} = require("../src/setup-panel");

function usableChannel(id, name = "music") {
  return {
    id,
    name,
    type: ChannelType.GuildText,
    rawPosition: 0,
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
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
  };
}

test("recovery panel is role-neutral and exposes one setup button", () => {
  const panel = buildSetupPanel();
  assert.equal(panel.components.length, 1);
  assert.equal(panel.components[0].components[0].data.custom_id, SETUP_BUTTON_ID);
  const json = JSON.stringify(panel);
  assert.match(json, /No role restriction is enabled/);
  assert.doesNotMatch(json, /Verified|Resident/);
});

test("setup channel selection prefers the configured usable channel", () => {
  const preferred = usableChannel("456", "commands");
  const other = usableChannel("789", "general");
  const guild = fakeGuild([other, preferred], other);
  assert.equal(chooseSetupChannel(guild, preferred.id), preferred);
});

test("recovery button saves the current channel with no role gate", async () => {
  const channel = usableChannel("456", "music");
  const guild = fakeGuild([channel], channel);
  const writes = [];
  let updatePayload = null;
  const interaction = {
    customId: SETUP_BUTTON_ID,
    guild,
    guildId: guild.id,
    channel,
    isButton: () => true,
    inGuild: () => true,
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild },
    update: async (payload) => {
      updatePayload = payload;
    },
  };
  const configStore = {
    async set(guildId, patch) {
      writes.push({ guildId, patch });
      return { musicTextChannelId: patch.musicTextChannelId };
    },
  };

  const handled = await handleSetupPanelInteraction(interaction, {
    configStore,
    logger: { log() {} },
  });

  assert.equal(handled, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].patch.musicTextChannelId, channel.id);
  assert.equal(writes[0].patch.roleVerifiedId, null);
  assert.equal(writes[0].patch.roleResidentId, null);
  assert.deepEqual(updatePayload.components, []);
});

test("recovery button refuses members without Manage Server", async () => {
  const channel = usableChannel("456");
  const guild = fakeGuild([channel], channel);
  let replyPayload = null;
  const interaction = {
    customId: SETUP_BUTTON_ID,
    guild,
    guildId: guild.id,
    channel,
    isButton: () => true,
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
