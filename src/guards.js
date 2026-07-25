function hasRoleByName(member, roleName) {
  return member.roles.cache.some((r) => r.name === roleName);
}

async function enforceGuards(interaction, cfg) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Server only.", ephemeral: true });
    return false;
  }

  if (interaction.channelId !== cfg.musicTextChannelId) {
    await interaction.reply({
      content: "Use the music commands channel for that.",
      ephemeral: true,
    });
    return false;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({ content: "Could not read your roles.", ephemeral: true });
    return false;
  }

  const ok1 = hasRoleByName(member, cfg.roleVerified);
  const ok2 = hasRoleByName(member, cfg.roleResident);

  if (!ok1 || !ok2) {
    const missing = [
      !ok1 ? cfg.roleVerified : null,
      !ok2 ? cfg.roleResident : null,
    ].filter(Boolean).join(", ");

    await interaction.reply({
      content: `Access locked. Missing: **${missing}**.`,
      ephemeral: true,
    });
    return false;
  }

  return true;
}

module.exports = { enforceGuards };
