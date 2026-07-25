"use strict";

const { Routes } = require("discord.js");

function commandNames(commands) {
  return commands
    .map((command) => String(command?.name || "").trim())
    .filter(Boolean)
    .sort();
}

function connectedGuildSummary(guilds) {
  const cached = [...(guilds?.cache?.values?.() || [])];
  if (!cached.length) return "none";
  return cached
    .map((guild) => `${guild.name || "Unnamed Server"} (${guild.id})`)
    .sort()
    .join(", ");
}

function verifyRegisteredCommands(expectedCommands, registeredCommands) {
  if (!Array.isArray(registeredCommands)) {
    throw new Error("Discord returned an invalid command-registration response.");
  }

  const expected = commandNames(expectedCommands);
  const actual = commandNames(registeredCommands);
  const missing = expected.filter((name) => !actual.includes(name));
  const unexpected = actual.filter((name) => !expected.includes(name));

  if (missing.length || unexpected.length) {
    throw new Error(
      `Discord command verification failed. Missing: ${missing.join(", ") || "none"}; ` +
        `unexpected: ${unexpected.join(", ") || "none"}.`
    );
  }

  return actual;
}

async function syncApplicationCommands({
  rest,
  applicationId,
  guildId,
  guilds,
  commands,
  logger = console,
}) {
  if (!rest || !applicationId || !Array.isArray(commands)) {
    throw new TypeError("Command sync requires rest, applicationId, and a commands array.");
  }

  const expectedNames = commandNames(commands);
  if (!expectedNames.length) throw new Error("No slash commands were built for registration.");

  const connected = [...(guilds?.cache?.values?.() || [])];
  let targetGuild = null;
  if (guildId) {
    targetGuild = guilds?.cache?.get?.(guildId);
    if (!targetGuild && connected.length === 1) {
      targetGuild = connected[0];
      logger.warn?.(
        `⚠️ Configured GUILD_ID ${guildId} is not connected. ` +
          `Using the bot's only server instead: ${targetGuild.name} (${targetGuild.id}).`
      );
    } else if (!targetGuild) {
      throw new Error(
        `GUILD_ID ${guildId} is not a server this bot is connected to. ` +
          `Connected servers: ${connectedGuildSummary(guilds)}.`
      );
    }
  } else if (connected.length === 1) {
    targetGuild = connected[0];
    logger.warn?.(
      `⚠️ GUILD_ID is not set. Auto-detected the bot's only server: ${targetGuild.name} (${targetGuild.id}).`
    );
  }

  if (targetGuild) {
    logger.log?.(
      `🧭 Registering ${expectedNames.length} guild commands for ${targetGuild.name} (${targetGuild.id})...`
    );
    const registered = await rest.put(
      Routes.applicationGuildCommands(applicationId, targetGuild.id),
      { body: commands }
    );
    const actualNames = verifyRegisteredCommands(commands, registered);
    logger.log?.(
      `✅ Discord accepted ${actualNames.length} guild commands for ${targetGuild.name} (${targetGuild.id}): ` +
        actualNames.map((name) => `/${name}`).join(", ")
    );
    return { scope: "guild", guildId: targetGuild.id, commandNames: actualNames };
  }

  logger.warn?.(
    "⚠️ GUILD_ID is not set and the bot is connected to zero or multiple servers. Registering global commands."
  );
  const registered = await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  const actualNames = verifyRegisteredCommands(commands, registered);
  logger.log?.(
    `✅ Discord accepted ${actualNames.length} global commands: ` +
      actualNames.map((name) => `/${name}`).join(", ")
  );
  return { scope: "global", guildId: null, commandNames: actualNames };
}

module.exports = {
  commandNames,
  connectedGuildSummary,
  syncApplicationCommands,
  verifyRegisteredCommands,
};
