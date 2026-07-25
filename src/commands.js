"use strict";

const { ChannelType, SlashCommandBuilder } = require("discord.js");

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("Configure Stoney Music for this server")
      .addChannelOption((option) =>
        option
          .setName("music_channel")
          .setDescription("Channel for Stoney Music commands; defaults to this channel")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      )
      .addRoleOption((option) =>
        option
          .setName("verified_role")
          .setDescription("Optional verified role required to use music commands")
      )
      .addRoleOption((option) =>
        option
          .setName("resident_role")
          .setDescription("Optional resident/member role required to use music commands")
      ),

    new SlashCommandBuilder()
      .setName("play")
      .setDescription("Play a song, playlist, or supported music link")
      .addStringOption((option) =>
        option
          .setName("query")
          .setDescription("Song name, YouTube URL, Apple Music link, or Spotify track link")
          .setRequired(true)
          .setMaxLength(500)
      ),

    new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
    new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue"),
    new SlashCommandBuilder().setName("queue").setDescription("Show the current queue and queue manager"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("Show the current player controller"),

    new SlashCommandBuilder()
      .setName("autoplay")
      .setDescription("Continue with related music when the human queue ends")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Enable or disable similar-music autoplay")
          .setRequired(true)
          .addChoices(
            { name: "On — play related music", value: "on" },
            { name: "Off", value: "off" }
          )
      ),

    new SlashCommandBuilder()
      .setName("volume")
      .setDescription("Set playback volume")
      .addIntegerOption((option) =>
        option
          .setName("value")
          .setDescription("Volume from 0 to 200")
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(200)
      ),

    new SlashCommandBuilder()
      .setName("loop")
      .setDescription("Set the loop mode")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("What should repeat")
          .setRequired(true)
          .addChoices(
            { name: "Off", value: "off" },
            { name: "Current track", value: "track" },
            { name: "Entire queue", value: "queue" }
          )
      ),

    new SlashCommandBuilder()
      .setName("filter")
      .setDescription("Apply an audio filter preset")
      .addStringOption((option) =>
        option
          .setName("preset")
          .setDescription("Filter preset")
          .setRequired(true)
          .addChoices(
            { name: "Clear filters", value: "clear" },
            { name: "Bass boost", value: "bassboost" },
            { name: "Nightcore", value: "nightcore" },
            { name: "Vaporwave", value: "vaporwave" },
            { name: "Karaoke", value: "karaoke" },
            { name: "Tremolo", value: "tremolo" },
            { name: "Vibrato", value: "vibrato" },
            { name: "8D rotation", value: "rotation" },
            { name: "Low pass", value: "lowpass" }
          )
      ),

    new SlashCommandBuilder()
      .setName("player")
      .setDescription("Show or use advanced Stoney Music player controls")
      .addSubcommand((subcommand) =>
        subcommand.setName("show").setDescription("Post a fresh persistent player controller")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("pause").setDescription("Pause the current track")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("resume").setDescription("Resume the current track")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("seek")
          .setDescription("Seek to an exact time")
          .addStringOption((option) =>
            option
              .setName("position")
              .setDescription("Seconds or a time such as 1:30 or 1:02:15")
              .setRequired(true)
              .setMaxLength(12)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("previous").setDescription("Play the previous track")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("replay").setDescription("Restart the current track")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("shuffle").setDescription("Shuffle all upcoming tracks")
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove")
          .setDescription("Remove a track from the queue")
          .addIntegerOption((option) =>
            option
              .setName("position")
              .setDescription("One-based queue position")
              .setRequired(true)
              .setMinValue(1)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("move")
          .setDescription("Move a queued track to another position")
          .addIntegerOption((option) =>
            option
              .setName("position")
              .setDescription("Current one-based queue position")
              .setRequired(true)
              .setMinValue(1)
          )
          .addIntegerOption((option) =>
            option
              .setName("destination")
              .setDescription("New one-based queue position")
              .setRequired(true)
              .setMinValue(1)
          )
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("clear").setDescription("Clear upcoming tracks without stopping the current song")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("mute").setDescription("Toggle mute while remembering the previous volume")
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("disconnect").setDescription("Clear the session and leave the voice channel")
      ),
  ].map((command) => command.toJSON());
}

module.exports = { buildCommands };
