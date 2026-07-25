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
    new SlashCommandBuilder().setName("queue").setDescription("Show the current queue"),
    new SlashCommandBuilder().setName("nowplaying").setDescription("Show the current track"),

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
            { name: "Bass boost", value: "bassboost" },
            { name: "Nightcore", value: "nightcore" },
            { name: "Vaporwave", value: "vaporwave" },
            { name: "Clear filters", value: "clear" }
          )
      ),
  ].map((command) => command.toJSON());
}

module.exports = { buildCommands };
