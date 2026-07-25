"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const SETUP_BUTTON_ID = "stoney_music:setup_here";
const SETUP_CHANNEL_SELECT_ID = "stoney_music:setup_channel";
const COMMAND_ORDER = [
  "setup",
  "play",
  "queue",
  "nowplaying",
  "skip",
  "stop",
  "volume",
  "loop",
  "filter",
];

function commandIdMap(commands) {
  return Object.fromEntries(
    [...commands.values()]
      .filter((command) => command?.id && command?.name)
      .map((command) => [String(command.name), String(command.id)])
  );
}

async function resolveCommandIds(guild, commandIds = {}) {
  if (Object.keys(commandIds).length) return commandIds;
  try {
    return commandIdMap(await guild.commands.fetch());
  } catch {
    return {};
  }
}

function formatCommandMentions(commandIds = {}) {
  return COMMAND_ORDER.map((name) => {
    const id = commandIds[name];
    return id ? `</${name}:${id}>` : `/${name}`;
  }).join(" • ");
}

function isUsableSetupChannel(channel, guild) {
  if (!channel || !guild) return false;
  if (![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) return false;

  const me = guild.members.me;
  if (!me) return false;
  const permissions = channel.permissionsFor(me);
  return Boolean(
    permissions?.has([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ])
  );
}

function chooseSetupChannel(guild, preferredChannelId = null) {
  const preferred = preferredChannelId ? guild.channels.cache.get(preferredChannelId) : null;
  if (isUsableSetupChannel(preferred, guild)) return preferred;
  if (isUsableSetupChannel(guild.systemChannel, guild)) return guild.systemChannel;

  return (
    [...guild.channels.cache.values()]
      .filter((channel) => isUsableSetupChannel(channel, guild))
      .sort((left, right) => (left.rawPosition || 0) - (right.rawPosition || 0))[0] || null
  );
}

function buildSetupPanel(commandIds = {}) {
  const embed = new EmbedBuilder()
    .setTitle("🎵 Stoney Music Setup")
    .setDescription(
      "Discord accepted the slash commands, but the mobile command picker is not displaying them. " +
        "Choose the channel where Stoney Music should be used. Nothing is hard-coded."
    )
    .addFields(
      {
        name: "Choose the music channel",
        value:
          "Use the channel picker below, or press **Use This Channel** as a shortcut. " +
          "No role restriction is enabled unless you choose one later.",
      },
      {
        name: "Registered commands",
        value: formatCommandMentions(commandIds),
      },
      {
        name: "Who can configure it",
        value: "Server owner or anyone with **Manage Server**.",
      }
    )
    .setFooter({ text: "Only one saved channel is used for music commands." });

  const pickerRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(SETUP_CHANNEL_SELECT_ID)
      .setPlaceholder("Choose the Stoney Music commands channel")
      .setMinValues(1)
      .setMaxValues(1)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
  );

  const buttonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SETUP_BUTTON_ID)
      .setLabel("Use This Channel")
      .setEmoji("🎛️")
      .setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [pickerRow, buttonRow] };
}

function buildSetupCompleteEmbed(saved, commandIds = {}) {
  return new EmbedBuilder()
    .setTitle("✅ Stoney Music Ready")
    .setDescription(`Music commands are restricted to <#${saved.musicTextChannelId}>.`)
    .addFields(
      { name: "Access gate", value: "No role gate is enabled." },
      { name: "Commands", value: formatCommandMentions(commandIds) }
    )
    .setFooter({ text: "The channel was selected in Discord and is not hard-coded." });
}

async function postSetupPanels({
  client,
  configStore,
  targetGuildId = null,
  commandIds = {},
  logger = console,
}) {
  const effectiveGuildId = targetGuildId || process.env.GUILD_ID || null;
  const guilds = effectiveGuildId
    ? [client.guilds.cache.get(effectiveGuildId)].filter(Boolean)
    : client.guilds.cache.size === 1
      ? [...client.guilds.cache.values()]
      : [];

  for (const guild of guilds) {
    if (configStore.hasSavedSetup(guild.id)) continue;

    const current = configStore.get(guild.id);
    if (current.setupPanelMessageId) {
      logger.log?.(
        `🧰 Stoney Music setup panel already recorded for ${guild.name} (${guild.id}): ` +
          `channel=${current.setupPanelChannelId || "unknown"} message=${current.setupPanelMessageId}.`
      );
      continue;
    }

    const channel = chooseSetupChannel(guild, current.setupPanelChannelId);
    if (!channel) {
      logger.error?.(
        `❌ Could not post Stoney Music setup panel in ${guild.name} (${guild.id}): ` +
          "no text channel allows View Channel, Send Messages, and Embed Links."
      );
      continue;
    }

    try {
      const resolvedCommandIds = await resolveCommandIds(guild, commandIds);
      const message = await channel.send(buildSetupPanel(resolvedCommandIds));
      await configStore.set(guild.id, {
        setupPanelChannelId: channel.id,
        setupPanelMessageId: message.id,
      });
      logger.log?.(
        `🧰 Posted one Stoney Music setup panel for ${guild.name} in #${channel.name} (${channel.id}); ` +
          `message=${message.id}.`
      );
    } catch (error) {
      logger.error?.(
        `❌ Could not post Stoney Music setup panel in #${channel.name} (${channel.id}): ` +
          (error?.message || String(error))
      );
    }
  }
}

async function resolveSelectedChannel(interaction) {
  if (interaction.isButton() && interaction.customId === SETUP_BUTTON_ID) {
    return interaction.channel;
  }

  if (interaction.isChannelSelectMenu() && interaction.customId === SETUP_CHANNEL_SELECT_ID) {
    const channelId = interaction.values?.[0];
    if (!channelId) return null;
    return (
      interaction.guild.channels.cache.get(channelId) ||
      interaction.guild.channels.fetch(channelId)
    );
  }

  return null;
}

async function handleSetupPanelInteraction(
  interaction,
  { configStore, commandIds = {}, logger = console }
) {
  const isSetupButton = interaction.isButton() && interaction.customId === SETUP_BUTTON_ID;
  const isSetupPicker =
    interaction.isChannelSelectMenu() && interaction.customId === SETUP_CHANNEL_SELECT_ID;
  if (!isSetupButton && !isSetupPicker) return false;

  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Server only.", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You need **Manage Server** to configure Stoney Music.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const current = configStore.get?.(interaction.guildId) || {};
  if (
    current.setupPanelMessageId &&
    interaction.message?.id !== current.setupPanelMessageId
  ) {
    await interaction.reply({
      content: "That is an old Stoney Music setup card. Use the newest card with the channel picker.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const channel = await resolveSelectedChannel(interaction);
  if (!isUsableSetupChannel(channel, interaction.guild)) {
    await interaction.reply({
      content:
        "Stoney Tunes cannot use that channel. Allow View Channel, Send Messages, and Embed Links first.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  const saved = await configStore.set(interaction.guildId, {
    musicTextChannelId: channel.id,
    roleVerifiedId: null,
    roleVerified: null,
    roleResidentId: null,
    roleResident: null,
    setupPanelChannelId: interaction.channelId || interaction.channel?.id || null,
    setupPanelMessageId: interaction.message?.id || null,
  });

  const resolvedCommandIds = await resolveCommandIds(interaction.guild, commandIds);
  const completeEmbed = buildSetupCompleteEmbed(saved, resolvedCommandIds);
  await interaction.update({ embeds: [completeEmbed], components: [] });

  if (channel.id !== interaction.channelId) {
    await channel.send({ embeds: [completeEmbed], allowedMentions: { parse: [] } });
  }

  logger.log?.(
    `✅ Stoney Music recovery setup completed for ${interaction.guild.name} (${interaction.guildId}): ` +
      `channel=${saved.musicTextChannelId} roleGate=none`
  );
  return true;
}

module.exports = {
  COMMAND_ORDER,
  SETUP_BUTTON_ID,
  SETUP_CHANNEL_SELECT_ID,
  buildSetupCompleteEmbed,
  buildSetupPanel,
  commandIdMap,
  chooseSetupChannel,
  formatCommandMentions,
  handleSetupPanelInteraction,
  isUsableSetupChannel,
  postSetupPanels,
  resolveCommandIds,
  resolveSelectedChannel,
};
