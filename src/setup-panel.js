"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const SETUP_BUTTON_ID = "stoney_music:setup_here";
const SETUP_CHANNEL_SELECT_ID = "stoney_music:setup_channel";
const SETUP_PANEL_VERSION = "3";
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
const lifecycleStates = new WeakMap();

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
    const globalCommands = await guild.client.application.commands.fetch();
    const resolved = commandIdMap(globalCommands);
    if (Object.keys(resolved).length) return resolved;
  } catch {
    // Fall through to the legacy guild lookup for migration compatibility.
  }

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
    .setTitle("🎵 Set Up Stoney Music")
    .setDescription(
      "Choose this server's music-command channel below. Every server has its own saved setup; " +
        "nothing is inherited from another server or hard-coded in hosting variables."
    )
    .addFields(
      {
        name: "Choose the music channel",
        value:
          "Use the channel picker below, or press **Use This Channel** as a shortcut. " +
          "No role restriction is enabled unless an admin explicitly chooses roles later.",
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
    .setFooter({ text: "This setup belongs only to this server." });

  const pickerRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId(SETUP_CHANNEL_SELECT_ID)
      .setPlaceholder("Choose this server's Stoney Music channel")
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
    .setDescription(`Music commands for this server are restricted to <#${saved.musicTextChannelId}>.`)
    .addFields(
      { name: "Access gate", value: "No role gate is enabled." },
      { name: "Commands", value: formatCommandMentions(commandIds) }
    )
    .setFooter({ text: "This channel was selected in Discord and saved only for this server." });
}

function installSetupLifecycle({ client, configStore, commandIds = {}, logger = console }) {
  const existing = lifecycleStates.get(client);
  if (existing) {
    existing.commandIds = commandIds;
    return;
  }

  const state = { commandIds };
  lifecycleStates.set(client, state);

  client.on(Events.GuildCreate, async (guild) => {
    try {
      await configStore.load();
      logger.log?.(`🆕 Stoney Music joined ${guild.name} (${guild.id}); starting per-server setup.`);
      await postSetupPanels({
        client,
        configStore,
        targetGuildId: guild.id,
        commandIds: state.commandIds,
        logger,
      });
    } catch (error) {
      logger.error?.(
        `❌ Could not start Stoney Music setup for new server ${guild.name} (${guild.id}): ` +
          (error?.stack || error)
      );
    }
  });
}

async function postSetupPanels({
  client,
  configStore,
  targetGuildId = null,
  commandIds = {},
  logger = console,
}) {
  installSetupLifecycle({ client, configStore, commandIds, logger });

  const guilds = targetGuildId
    ? [client.guilds.cache.get(targetGuildId)].filter(Boolean)
    : [...client.guilds.cache.values()];

  for (const guild of guilds) {
    if (configStore.hasSavedSetup(guild.id)) continue;

    const current = configStore.get(guild.id);
    const hasCurrentPanel =
      current.setupPanelMessageId && current.setupPanelVersion === SETUP_PANEL_VERSION;
    if (hasCurrentPanel) {
      logger.log?.(
        `🧰 Current Stoney Music setup panel already recorded for ${guild.name} (${guild.id}): ` +
          `channel=${current.setupPanelChannelId || "unknown"} message=${current.setupPanelMessageId}.`
      );
      continue;
    }

    const channel = chooseSetupChannel(guild, current.setupPanelChannelId);
    if (!channel) {
      logger.error?.(
        `❌ Could not post Stoney Music setup in ${guild.name} (${guild.id}): ` +
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
        setupPanelVersion: SETUP_PANEL_VERSION,
      });
      logger.log?.(
        `🧰 Posted Stoney Music setup for ${guild.name} (${guild.id}) in #${channel.name} ` +
          `(${channel.id}); message=${message.id}.`
      );
    } catch (error) {
      logger.error?.(
        `❌ Could not post Stoney Music setup in ${guild.name} #${channel.name} (${channel.id}): ` +
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
    current.setupPanelVersion !== SETUP_PANEL_VERSION ||
    (current.setupPanelMessageId && interaction.message?.id !== current.setupPanelMessageId)
  ) {
    await interaction.reply({
      content: "That is an old Stoney Music setup card. Use this server's newest channel-picker card.",
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
    setupPanelVersion: SETUP_PANEL_VERSION,
  });

  const resolvedCommandIds = await resolveCommandIds(interaction.guild, commandIds);
  const completeEmbed = buildSetupCompleteEmbed(saved, resolvedCommandIds);
  await interaction.update({ embeds: [completeEmbed], components: [] });

  if (channel.id !== interaction.channelId) {
    await channel.send({ embeds: [completeEmbed], allowedMentions: { parse: [] } });
  }

  logger.log?.(
    `✅ Stoney Music setup completed for ${interaction.guild.name} (${interaction.guildId}): ` +
      `channel=${saved.musicTextChannelId} roleGate=none`
  );
  return true;
}

module.exports = {
  COMMAND_ORDER,
  SETUP_BUTTON_ID,
  SETUP_CHANNEL_SELECT_ID,
  SETUP_PANEL_VERSION,
  buildSetupCompleteEmbed,
  buildSetupPanel,
  commandIdMap,
  chooseSetupChannel,
  formatCommandMentions,
  handleSetupPanelInteraction,
  installSetupLifecycle,
  isUsableSetupChannel,
  postSetupPanels,
  resolveCommandIds,
  resolveSelectedChannel,
};
