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
  REST,
} = require("discord.js");

const { buildCommands } = require("./commands");
const { syncApplicationCommands } = require("./command-sync");
const { enforceGuards } = require("./guards");
const { PlayerManager } = require("./player");
const { MusicResolutionError, toQueueTrack } = require("./resolver");
const { safeTrackDescription } = require("./format");

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

function publicErrorMessage(error) {
  if (error instanceof MusicResolutionError) return error.userMessage;
  if (error?.message === "The bot is already connected to another voice channel.") {
    return "Join the same voice channel as Stoney Music first.";
  }
  if (error?.message === "No Lavalink node is ready.") {
    return "The audio server is still connecting. Try again in a moment.";
  }
  return "Playback failed unexpectedly. The detailed cause was written to the bot logs.";
}

async function sendInteractionError(interaction, error) {
  const content = `❌ ${publicErrorMessage(error)}`;
  if (interaction.deferred) {
    await interaction.editReply({ content, embeds: [] });
  } else if (interaction.replied) {
    await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

const cfg = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID || null,
  musicTextChannelId: process.env.MUSIC_TEXT_CHANNEL_ID,
  roleVerified: process.env.ROLE_VERIFIED || "Verified",
  roleResident: process.env.ROLE_RESIDENT || "Resident",
};

const missingDiscord = missingKeys(["DISCORD_TOKEN", "MUSIC_TEXT_CHANNEL_ID"]);
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

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  players = new PlayerManager({ nodes, discordClient: client });

  const rest = new REST({ version: "10" }).setToken(cfg.token);
  const commands = buildCommands();
  const applicationId = client.application.id;

  try {
    await syncApplicationCommands({
      rest,
      applicationId,
      guildId: cfg.guildId,
      guilds: client.guilds,
      commands,
      logger: console,
    });
  } catch (error) {
    console.error("❌ Slash command registration failed:", {
      code: error?.code,
      status: error?.status,
      message: error?.message || String(error),
      guildId: cfg.guildId,
      applicationId,
    });
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (!players) {
    await interaction.reply({
      content: "Stoney Music is still starting. Try again in a moment.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!(await enforceGuards(interaction, cfg))) return;

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

      const title = startedFirst ? "▶️ Now Playing" : "➕ Added to Queue";
      const countText = tracks.length > 1 ? `\n\n**Queued:** ${tracks.length} tracks` : "";
      const sourceText = resolution.playlistName
        ? `Source: ${resolution.playlistName}`
        : `Resolver: ${resolution.source}`;

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(`${safeTrackDescription(first)}${countText}`)
        .setFooter({ text: `${sourceText} • Requested by ${interaction.user.username}` });

      if (first?.artworkUrl) embed.setThumbnail(first.artworkUrl);
      if (resolution.notices?.length) {
        embed.addFields({ name: "Note", value: resolution.notices.join("\n").slice(0, 1024) });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const controlsPlayback = ["skip", "stop", "volume", "loop", "filter"].includes(
      interaction.commandName
    );
    if (controlsPlayback && guildPlayer.isConnected()) {
      if (!voiceChannel || !guildPlayer.isInVoiceChannel(voiceChannel.id)) {
        await interaction.reply({
          content: "Join the same voice channel as Stoney Music to control playback.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.commandName === "skip") {
      const skipped = await guildPlayer.skip();
      await interaction.reply(skipped ? "⏭️ Skipped." : "Nothing is currently playing.");
      return;
    }

    if (interaction.commandName === "stop") {
      await guildPlayer.stopAndClear();
      await interaction.reply("⏹️ Stopped and cleared the queue.");
      return;
    }

    if (interaction.commandName === "queue") {
      const now = guildPlayer.nowPlaying();
      const upcoming = guildPlayer.getQueuePreview(10);
      const lines = [];

      lines.push(now ? `**Now:** ${safeTrackDescription(now)}` : "**Now:** Nothing playing");
      if (upcoming.length) {
        lines.push("\n**Up Next:**");
        upcoming.forEach((track, index) => lines.push(`${index + 1}. ${safeTrackDescription(track)}`));
        const hidden = guildPlayer.queueLength() - upcoming.length;
        if (hidden > 0) lines.push(`…and ${hidden} more.`);
      } else {
        lines.push("\nNo upcoming tracks.");
      }

      await interaction.reply({ content: lines.join("\n") });
      return;
    }

    if (interaction.commandName === "nowplaying") {
      const now = guildPlayer.nowPlaying();
      if (!now) {
        await interaction.reply({ content: "Nothing is playing.", flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply(`🎶 **Now Playing:** ${safeTrackDescription(now)}`);
      return;
    }

    if (interaction.commandName === "volume") {
      const volume = interaction.options.getInteger("value", true);
      const actual = await guildPlayer.setVolume(volume);
      await interaction.reply(`🔊 Volume set to **${actual}**.`);
      return;
    }

    if (interaction.commandName === "loop") {
      const mode = interaction.options.getString("mode", true);
      await guildPlayer.setLoop(mode);
      await interaction.reply(`🔁 Loop mode: **${mode}**.`);
      return;
    }

    if (interaction.commandName === "filter") {
      const preset = interaction.options.getString("preset", true);
      await guildPlayer.setFilterPreset(preset);
      await interaction.reply(`✨ Filter: **${preset}**.`);
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
