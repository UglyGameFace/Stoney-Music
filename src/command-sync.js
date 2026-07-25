"use strict";

const { Routes } = require("discord.js");

function commandNames(commands) {
  return commands
    .map((command) => String(command?.name || "").trim())
    .filter(Boolean)
    .sort();
}

function commandIdMap(commands) {
  return Object.fromEntries(
    commands
      .filter((command) => command?.id && command?.name)
      .map((command) => [String(command.name), String(command.id)])
  );
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

async function clearLegacyGuildCommands({ rest, applicationId, legacyGuildId, logger = console }) {
  if (!legacyGuildId) return false;

  const route = Routes.applicationGuildCommands(applicationId, legacyGuildId);
  try {
    const existing = await rest.get(route);
    if (!Array.isArray(existing) || existing.length === 0) return false;

    await rest.put(route, { body: [] });
    logger.log?.(
      `🧹 Removed ${existing.length} legacy guild-only commands from ${legacyGuildId}. ` +
        "Stoney Music now uses one public global command set."
    );
    return true;
  } catch (error) {
    logger.warn?.(
      `⚠️ Could not remove legacy guild-only commands from ${legacyGuildId}: ` +
        (error?.message || String(error))
    );
    return false;
  }
}

async function syncApplicationCommands({
  rest,
  applicationId,
  guildId: legacyGuildId = null,
  commands,
  logger = console,
}) {
  if (!rest || !applicationId || !Array.isArray(commands)) {
    throw new TypeError("Command sync requires rest, applicationId, and a commands array.");
  }

  const expectedNames = commandNames(commands);
  if (!expectedNames.length) throw new Error("No slash commands were built for registration.");

  logger.log?.(
    `🌐 Registering ${expectedNames.length} public global commands for every server using Stoney Music...`
  );
  const registered = await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  const actualNames = verifyRegisteredCommands(commands, registered);
  logger.log?.(
    `✅ Discord accepted ${actualNames.length} public global commands: ` +
      actualNames.map((name) => `/${name}`).join(", ")
  );

  // GUILD_ID is never used to select a live server anymore. During the migration
  // deployment only, an existing value is used to remove the old guild-only command set.
  await clearLegacyGuildCommands({ rest, applicationId, legacyGuildId, logger });

  return {
    scope: "global",
    guildId: null,
    commandNames: actualNames,
    commandIds: commandIdMap(registered),
  };
}

module.exports = {
  clearLegacyGuildCommands,
  commandIdMap,
  commandNames,
  syncApplicationCommands,
  verifyRegisteredCommands,
};
