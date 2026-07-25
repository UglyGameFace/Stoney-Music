"use strict";

const { MessageFlags } = require("discord.js");

function hasConfiguredRole(member, roleId, roleName) {
  if (!roleId && !roleName) return true;
  if (roleId && member.roles.cache.has(roleId)) return true;
  if (!roleName) return false;
  return member.roles.cache.some((role) => role.name.toLowerCase() === roleName.toLowerCase());
}

function roleLabel(roleId, roleName) {
  if (roleId) return `<@&${roleId}>`;
  return roleName || "Unknown role";
}

async function enforceGuards(interaction, cfg) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Server only.", flags: MessageFlags.Ephemeral });
    return false;
  }

  if (!cfg.musicTextChannelId) {
    await interaction.reply({
      content: "Stoney Music is not configured yet. A server admin needs to run `/setup`.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (interaction.channelId !== cfg.musicTextChannelId) {
    await interaction.reply({
      content: `Use Stoney Music in <#${cfg.musicTextChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({
      content: "Could not read your roles.",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const verified = hasConfiguredRole(member, cfg.roleVerifiedId, cfg.roleVerified);
  const resident = hasConfiguredRole(member, cfg.roleResidentId, cfg.roleResident);

  if (!verified || !resident) {
    const missing = [
      !verified ? roleLabel(cfg.roleVerifiedId, cfg.roleVerified) : null,
      !resident ? roleLabel(cfg.roleResidentId, cfg.roleResident) : null,
    ].filter(Boolean);

    await interaction.reply({
      content: `Access locked. Missing: ${missing.join(", ")}.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  return true;
}

module.exports = { enforceGuards, hasConfiguredRole, roleLabel };
