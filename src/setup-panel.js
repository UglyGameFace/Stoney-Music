"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
} = require("discord.js");

const SETUP_BUTTON_ID = "stoney_music:setup_here";

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

function buildSetupPanel() {
  const embed = new EmbedBuilder()
    .setTitle("🎵 Stoney Music Setup")
    .setDescription(
      "Discord accepted the slash commands, but the mobile command picker is not displaying them. " +
        "Use the button below to configure Stoney Music in this channel without relying on slash commands."
    )
    .addFields(
      {
        name: "What the button does",
        value: "Sets this channel as the music channel. No role restriction is enabled unless you choose one later.",
      },
      {
        name: "Who can use it",
        value: "Server owner or anyone with **Manage Server**.",
      }
    )
    .setFooter({ text: "This recovery panel becomes inactive after setup succeeds." });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(SETUP_BUTTON_ID)
      .setLabel("Set Up In This Channel")
      .setEmoji("🎛️")
      .setStyle(ButtonStyle.Primary)
  );

  return { embeds: [embed], components: [row] };
}

function buildSetupCompleteEmbed(saved) {
  return new EmbedBuilder()
    .setTitle("✅ Stoney Music Setup Complete")
    .setDescription(`Music controls are configured for <#${saved.musicTextChannelId}>.`)
    .addFields({ name: "Access gate", value: "No role gate is enabled." })
    .setFooter({ text: "The slash commands remain registered; this panel bypassed the picker issue." });
}

async function postSetupPanels({ client, configStore, logger = console }) {
  for (const guild of client.guilds.cache.values()) {
    if (configStore.hasSavedSetup(guild.id)) continue;

    const current = configStore.get(guild.id);
    const channel = chooseSetupChannel(guild, current.musicTextChannelId);
    if (!channel) {
      logger.error?.(
        `❌ Could not post Stoney Music setup panel in ${guild.name} (${guild.id}): ` +
          "no text channel allows View Channel, Send Messages, and Embed Links."
      );
      continue;
    }

    try {
      const message = await channel.send(buildSetupPanel());
      logger.log?.(
        `🧰 Posted Stoney Music recovery setup panel in #${channel.name} (${channel.id}); ` +
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

async function handleSetupPanelInteraction(interaction, { configStore, logger = console }) {
  if (!interaction.isButton() || interaction.customId !== SETUP_BUTTON_ID) return false;

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

  const channel = interaction.channel;
  if (!isUsableSetupChannel(channel, interaction.guild)) {
    await interaction.reply({
      content: "Stoney Tunes cannot use this channel. Allow View Channel, Send Messages, and Embed Links first.",
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
  });

  await interaction.update({ embeds: [buildSetupCompleteEmbed(saved)], components: [] });
  logger.log?.(
    `✅ Stoney Music recovery setup completed for ${interaction.guild.name} (${interaction.guildId}): ` +
      `channel=${saved.musicTextChannelId} roleGate=none`
  );
  return true;
}

module.exports = {
  SETUP_BUTTON_ID,
  buildSetupCompleteEmbed,
  buildSetupPanel,
  chooseSetupChannel,
  handleSetupPanelInteraction,
  isUsableSetupChannel,
  postSetupPanels,
};
