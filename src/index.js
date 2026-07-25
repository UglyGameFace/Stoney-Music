"use strict";

const { loadEnvironment } = require("./env");

loadEnvironment();

const {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  REST,
} = require("discord.js");

const { buildCommands } = require("./commands");
const { syncApplicationCommands } = require("./command-sync");
const { GuildConfigStore } = require("./config-store");
const { enforceGuards } = require("./guards");
const { escapeDiscordMarkdown, safeTrackDescription } = require("./format");
const {
  PlayerControllerManager,
  buildQueuePayload,
  formatDuration,
} = require("./player-controller");
const { PlayerManager } = require("./player");
const { MusicResolutionError, toQueueTrack } = require("./resolver");
const { handleSetupPanelInteraction, postSetupPanels } = require("./setup-panel");

function missingKeys(keys) {
  return keys.filter((key) => !process.env[key] || String(process.env[key]).trim() === "");
}

function sanitizeHost(raw) {
  return String(raw || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^wss?:\/\//i, "")
    .replace(/\/+$/, "");
}

function parseSeekPosition(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("Enter a seek position.");
  const parts = text.split(":");
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error("Use seconds or a time like 1:30 or 1:02:15.");
  }
  const numbers = parts.map(Number);
  let seconds = 0;
  for (const number of numbers) seconds = seconds * 60 + number;
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new Error("That seek position is invalid.");
  return seconds * 1_000;
}

function publicErrorMessage(error) {
  if (error instanceof MusicResolutionError) return error.userMessage;
  const message = String(error?.message || "");
  if (message === "The bot is already connected to another voice channel.") {
    return "Join the same voice channel as Stoney Music first.";
  }
  if (message === "No Lavalink node is ready.") {
    return "The audio server is still connecting. Try again in a moment.";
  }
  if (
    message === "Nothing is currently playing." ||
    message === "Live streams cannot be seeked." ||
    message.includes("queue position is out of range") ||
    message.includes("seek position") ||
    message.includes("time like")
  ) {
    return message;
  }
  return "Playback failed unexpectedly. The detailed cause was written to the bot logs.";
}

async function sendInteractionError(interaction, error) {
  const content = `❌ ${publicErrorMessage(error)}`;
  if (interaction.deferred) {
    await interaction.editReply({ content, embeds: [], components: [] });
  } else if (interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

async function sendComponentError(interaction, error) {
  const payload = {
    content: `❌ ${publicErrorMessage(error)}`,
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.isModalSubmit?.() && interaction.deferred && !interaction.replied) {
    await interaction.editReply({ content: payload.content, components: [], embeds: [] });
  } else if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

async function sendSetupPanelError(interaction) {
  if (!interaction.isRepliable()) return;
  const payload = {
    content: "❌ Setup failed unexpectedly. The detailed cause was written to the bot logs.",
    flags: MessageFlags.Ephemeral,
  };
  if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
  else await interaction.reply(payload);
}

function requireSameVoice(interaction, guildPlayer) {
  const memberVoice = interaction.member?.voice?.channelId || interaction.member?.voice?.channel?.id;
  return Boolean(guildPlayer.isConnected() && memberVoice && guildPlayer.isInVoiceChannel(memberVoice));
}

const cfg = {
  token: process.env.DISCORD_TOKEN,
};

const configStore = new GuildConfigStore({
  defaults: {
    roleVerifiedId: null,
    roleVerified: null,
    roleResidentId: null,
    roleResident: null,
  },
});

const missingDiscord = missingKeys(["DISCORD_TOKEN"]);
if (missingDiscord.length) {
  throw new Error(
    `Missing required environment variable(s): ${missingDiscord.join(", ")}. ` +
      "Set them in Discloud or a local .env file."
  );
}

const missingLavalink = missingKeys(["LAVALINK_HOST", "LAVALINK_PORT", "LAVALINK_PASSWORD"]);
if (missingLavalink.length) {
  throw new Error(
    `Missing Lavalink environment variable(s): ${missingLavalink.join(", ")}. ` +
      "Set LAVALINK_HOST, LAVALINK_PORT, LAVALINK_PASSWORD, and optionally LAVALINK_SECURE."
  );
}

const lavalinkHost = sanitizeHost(process.env.LAVALINK_HOST);
const lavalinkPort = String(process.env.LAVALINK_PORT).trim();
const lavalinkSecure = String(process.env.LAVALINK_SECURE || "false").toLowerCase() === "true";
const nodes = [
  {
    name: "main",
    url: `${lavalinkHost}:${lavalinkPort}`,
    auth: String(process.env.LAVALINK_PASSWORD).trim(),
    secure: lavalinkSecure,
  },
];

console.log(
  `🎛️ Lavalink configured: host=${lavalinkHost} port=${lavalinkPort} secure=${lavalinkSecure}`
);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  partials: [Partials.Channel],
});

let players = null;
let controllers = null;

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await configStore.load();
  players = new PlayerManager({ nodes, discordClient: client });
  controllers = new PlayerControllerManager({ client, players, logger: console });

  const rest = new REST({ version: "10" }).setToken(cfg.token);
  const commands = buildCommands();
  const applicationId = client.application.id;

  try {
    await syncApplicationCommands({
      rest,
      applicationId,
      commands,
      logger: console,
    });
  } catch (error) {
    console.error("❌ Slash command registration failed:", {
      code: error?.code,
      status: error?.status,
      message: error?.message || String(error),
      applicationId,
    });
  }

  try {
    await postSetupPanels({ client, configStore, logger: console });
  } catch (error) {
    console.error("❌ Recovery setup panel failed:", error?.stack || error);
  }
});

async function handleSetup(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: "Server only.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "You need **Manage Server** to configure Stoney Music.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = configStore.get(interaction.guildId);
  const musicChannel = interaction.options.getChannel("music_channel") || interaction.channel;
  if (!musicChannel?.isTextBased?.() || musicChannel.isThread?.()) {
    await interaction.reply({
      content: "Choose a regular server text channel for music commands.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const verifiedRole =
    interaction.options.getRole("verified_role") ||
    interaction.guild.roles.cache.get(existing.roleVerifiedId) ||
    null;
  const residentRole =
    interaction.options.getRole("resident_role") ||
    interaction.guild.roles.cache.get(existing.roleResidentId) ||
    null;

  const saved = await configStore.set(interaction.guildId, {
    musicTextChannelId: musicChannel.id,
    roleVerifiedId: verifiedRole?.id || null,
    roleVerified: verifiedRole?.name || null,
    roleResidentId: residentRole?.id || null,
    roleResident: residentRole?.name || null,
  });

  const access = [
    saved.roleVerifiedId ? `<@&${saved.roleVerifiedId}>` : null,
    saved.roleResidentId ? `<@&${saved.roleResidentId}>` : null,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setTitle("✅ Stoney Music Setup Complete")
    .setDescription(`Music commands will work in <#${saved.musicTextChannelId}>.`)
    .addFields({
      name: "Who can use it",
      value: access.length ? `Members must have: ${access.join(" and ")}` : "No role gate is enabled.",
    })
    .setFooter({ text: "Run /setup again any time to change these settings." });

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  console.log(
    `✅ Stoney Music configured for ${interaction.guild.name} (${interaction.guildId}): ` +
      `channel=${saved.musicTextChannelId} verified=${saved.roleVerifiedId || "none"} ` +
      `resident=${saved.roleResidentId || "none"}`
  );
}

async function handleAdvancedPlayerCommand(interaction, guildPlayer) {
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "show") {
    await controllers.show(interaction, guildPlayer);
    return;
  }

  if (!guildPlayer.isConnected()) {
    await interaction.reply({
      content: "Nothing is playing. Start a song first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (!requireSameVoice(interaction, guildPlayer)) {
    await interaction.reply({
      content: "Join the same voice channel as Stoney Music to control playback.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  let status;
  if (subcommand === "pause") {
    status = (await guildPlayer.setPaused(true)) ? "⏸️ Paused." : "Nothing is currently playing.";
  } else if (subcommand === "resume") {
    await guildPlayer.setPaused(false);
    status = "▶️ Resumed.";
  } else if (subcommand === "seek") {
    const target = await guildPlayer.seekTo(
      parseSeekPosition(interaction.options.getString("position", true))
    );
    status = `⏩ Seeked to **${formatDuration(target)}**.`;
  } else if (subcommand === "previous") {
    const previous = await guildPlayer.previous();
    status = previous
      ? `⏮️ Playing **${escapeDiscordMarkdown(previous.title)}**.`
      : "No previous track is available.";
  } else if (subcommand === "replay") {
    status = (await guildPlayer.replay()) ? "🔄 Replaying the current track." : "Nothing is playing.";
  } else if (subcommand === "shuffle") {
    status = `🔀 Shuffled **${guildPlayer.shuffle()}** queued tracks.`;
  } else if (subcommand === "remove") {
    const position = interaction.options.getInteger("position", true);
    const removed = guildPlayer.removeQueueTrack(position);
    status = `➖ Removed **${escapeDiscordMarkdown(removed.title)}** from position ${position}.`;
  } else if (subcommand === "move") {
    const position = interaction.options.getInteger("position", true);
    const destination = interaction.options.getInteger("destination", true);
    const moved = guildPlayer.moveQueueTrack(position, destination);
    status = `↕️ Moved **${escapeDiscordMarkdown(moved.title)}** from ${position} to ${destination}.`;
  } else if (subcommand === "clear") {
    const removed = guildPlayer.clearQueue();
    status = `🧹 Cleared **${removed}** upcoming track${removed === 1 ? "" : "s"}.`;
  } else if (subcommand === "mute") {
    status = `🔇 Volume is now **${await guildPlayer.toggleMute()}%**.`;
  } else if (subcommand === "disconnect") {
    await guildPlayer.disconnect();
    status = "⏏️ Disconnected and cleared the player session.";
  } else {
    throw new Error("Unknown player subcommand.");
  }

  await interaction.reply(status);
  await controllers.refresh(interaction.guildId, { notice: status });
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (await handleSetupPanelInteraction(interaction, { configStore, logger: console })) return;
  } catch (error) {
    console.error("Stoney Music recovery setup failed:", error?.stack || error);
    await sendSetupPanelError(interaction);
    return;
  }

  if (controllers) {
    try {
      if (await controllers.handle(interaction)) return;
    } catch (error) {
      console.error("Stoney Music player control failed:", {
        guildId: interaction.guildId,
        userId: interaction.user?.id,
        customId: interaction.customId,
        message: error?.message || String(error),
        stack: error?.stack,
      });
      await sendComponentError(interaction, error);
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "setup") {
    try {
      await handleSetup(interaction);
    } catch (error) {
      console.error("Stoney Music setup failed:", error);
      await sendInteractionError(interaction, error);
    }
    return;
  }

  if (!players || !controllers) {
    await interaction.reply({
      content: "Stoney Music is still starting. Try again in a moment.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const guildConfig = configStore.get(interaction.guildId);
  if (!(await enforceGuards(interaction, guildConfig))) return;

  const guild = interaction.guild;
  const member = interaction.member;
  const voiceChannel = member.voice?.channel;
  const guildPlayer = players.get(guild.id);

  try {
    if (interaction.commandName === "play") {
      if (!voiceChannel) {
        await interaction.reply({
          content: "Join a voice channel first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (guildPlayer.isConnected() && !guildPlayer.isInVoiceChannel(voiceChannel.id)) {
        await interaction.reply({
          content: "Join the same voice channel as Stoney Music first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      if (!guildPlayer.isConnected()) {
        await guildPlayer.connect({
          guildId: guild.id,
          voiceChannelId: voiceChannel.id,
          shardId: guild.shardId,
          deaf: true,
          mute: false,
        });
      }

      const query = interaction.options.getString("query", true).trim();
      const resolution = await players.resolveQuery(query);
      const tracks = resolution.tracks.map((track) => toQueueTrack(track, interaction.user.id));
      const wasIdle = !guildPlayer.nowPlaying();

      guildPlayer.enqueueMany(tracks);
      const started = await guildPlayer.playNext();
      const first = tracks[0];
      const startedFirst = wasIdle && started?.encoded === first?.encoded;
      const status = startedFirst
        ? `▶️ Now playing ${first.title}.`
        : tracks.length > 1
          ? `➕ Added ${tracks.length} tracks to the queue.`
          : `➕ Added ${first.title} to the queue.`;

      await controllers.publish(interaction, guildPlayer, { notice: status });
      return;
    }

    if (interaction.commandName === "player") {
      await handleAdvancedPlayerCommand(interaction, guildPlayer);
      return;
    }

    const controlsPlayback = ["skip", "stop", "autoplay", "volume", "loop", "filter"].includes(
      interaction.commandName
    );
    if (controlsPlayback && guildPlayer.isConnected() && !requireSameVoice(interaction, guildPlayer)) {
      await interaction.reply({
        content: "Join the same voice channel as Stoney Music to control playback.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "skip") {
      const skipped = await guildPlayer.skip();
      const status = skipped ? "⏭️ Skipped." : "Nothing is currently playing.";
      await interaction.reply(status);
      await controllers.refresh(interaction.guildId, { notice: status });
      return;
    }

    if (interaction.commandName === "stop") {
      await guildPlayer.stopAndClear();
      const status = "⏹️ Stopped, cleared the queue, and disabled autoplay.";
      await interaction.reply(status);
      await controllers.refresh(interaction.guildId, { notice: status });
      return;
    }

    if (interaction.commandName === "queue") {
      await interaction.reply({ ...buildQueuePayload(guildPlayer, 0), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "nowplaying") {
      await controllers.show(interaction, guildPlayer);
      return;
    }

    if (interaction.commandName === "autoplay") {
      const enabled = interaction.options.getString("mode", true) === "on";
      if (enabled && !guildPlayer.nowPlaying()) {
        await interaction.reply({
          content: "Start a song first so autoplay has a real song and artist to build the station from.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const active = await guildPlayer.setAutoplay(enabled);
      const status = active
        ? "♾️ Autoplay is on. Related music will continue after the human queue ends."
        : "♾️ Autoplay is off. Playback will stop when the human queue ends.";
      await interaction.reply(status);
      await controllers.refresh(interaction.guildId, { notice: status });
      return;
    }

    if (interaction.commandName === "volume") {
      const volume = interaction.options.getInteger("value", true);
      const actual = await guildPlayer.setVolume(volume);
      const status = `🔊 Volume set to **${actual}%**.`;
      await interaction.reply(status);
      await controllers.refresh(interaction.guildId, { notice: status });
      return;
    }

    if (interaction.commandName === "loop") {
      const mode = interaction.options.getString("mode", true);
      await guildPlayer.setLoop(mode);
      const status = `🔁 Loop mode: **${mode}**.`;
      await interaction.reply(status);
      await controllers.refresh(interaction.guildId, { notice: status });
      return;
    }

    if (interaction.commandName === "filter") {
      const preset = interaction.options.getString("preset", true);
      await guildPlayer.setFilterPreset(preset);
      const status = `✨ Filter: **${preset}**.`;
      await interaction.reply(status);
      await controllers.refresh(interaction.guildId, { notice: status });
      return;
    }
  } catch (error) {
    console.error("Music command failed", {
      command: interaction.commandName,
      guildId: interaction.guildId,
      userId: interaction.user?.id,
      code: error?.code,
      message: error?.message || String(error),
      attempts: error?.attempts,
      stack: error?.stack,
    });
    await sendInteractionError(interaction, error);
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

client.login(cfg.token);
