"use strict";

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { escapeDiscordMarkdown, safeHttpUrl, safeTrackDescription } = require("./format");

const PLAYER_PREFIX = "stoney_player:";
const QUEUE_PAGE_SIZE = 10;
const PROGRESS_SEGMENTS = 16;
const POSITION_REFRESH_MS = 12_000;

const IDS = Object.freeze({
  previous: `${PLAYER_PREFIX}previous`,
  rewind: `${PLAYER_PREFIX}rewind`,
  pause: `${PLAYER_PREFIX}pause`,
  forward: `${PLAYER_PREFIX}forward`,
  skip: `${PLAYER_PREFIX}skip`,
  replay: `${PLAYER_PREFIX}replay`,
  shuffle: `${PLAYER_PREFIX}shuffle`,
  loop: `${PLAYER_PREFIX}loop`,
  autoplay: `${PLAYER_PREFIX}autoplay`,
  stop: `${PLAYER_PREFIX}stop`,
  volumeDown: `${PLAYER_PREFIX}volume_down`,
  mute: `${PLAYER_PREFIX}mute`,
  volumeUp: `${PLAYER_PREFIX}volume_up`,
  queue: `${PLAYER_PREFIX}queue`,
  disconnect: `${PLAYER_PREFIX}disconnect`,
  filter: `${PLAYER_PREFIX}filter`,
  queuePage: `${PLAYER_PREFIX}queue_page`,
  queueRemove: `${PLAYER_PREFIX}queue_remove`,
  queueMove: `${PLAYER_PREFIX}queue_move`,
  queueClear: `${PLAYER_PREFIX}queue_clear`,
  queueShuffle: `${PLAYER_PREFIX}queue_shuffle`,
  queueClearConfirm: `${PLAYER_PREFIX}queue_clear_confirm`,
  queueClearCancel: `${PLAYER_PREFIX}queue_clear_cancel`,
  modalRemove: `${PLAYER_PREFIX}modal_remove`,
  modalMove: `${PLAYER_PREFIX}modal_move`,
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatDuration(milliseconds, { stream = false } = {}) {
  if (stream) return "LIVE";
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function buildProgressBar(positionMs, durationMs, { stream = false } = {}) {
  if (stream) return "🔴 LIVE";
  const duration = Math.max(0, Number(durationMs || 0));
  const position = clamp(Number(positionMs || 0), 0, duration || 0);
  const ratio = duration > 0 ? position / duration : 0;
  const marker = clamp(Math.round(ratio * (PROGRESS_SEGMENTS - 1)), 0, PROGRESS_SEGMENTS - 1);
  const segments = Array.from({ length: PROGRESS_SEGMENTS }, (_, index) =>
    index === marker ? "🔘" : index < marker ? "▬" : "▭"
  );
  return `${segments.join("")}\n\`${formatDuration(position)} / ${formatDuration(duration)}\``;
}

function sourceLabel(track) {
  if (!track) return "Unknown";
  if (track.fallbackFrom) return `${track.sourceName || "alternate"} fallback`;
  if (track.autoplay) return `${track.sourceName || track.autoplaySource || "alternate"} • recommended`;
  return track.sourceName || "unknown";
}

function loopLabel(mode) {
  if (mode === "track") return "Track";
  if (mode === "queue") return "Queue";
  return "Off";
}

function buildPlayerEmbed(guildPlayer, { notice = null } = {}) {
  const state = guildPlayer.snapshot();
  const track = state.current;
  const activeIcon = !track ? "⏹️" : state.paused ? "⏸️" : track.autoplay ? "♾️" : "▶️";
  const embed = new EmbedBuilder().setTitle(`${activeIcon} Stoney Music Player`);

  if (!track) {
    embed
      .setDescription(state.connected ? "Nothing is currently playing." : "The player is disconnected.")
      .addFields(
        { name: "Queue", value: String(state.queue.length), inline: true },
        { name: "Volume", value: `${state.volume}%`, inline: true },
        { name: "Autoplay", value: state.autoplayEnabled ? "On" : "Off", inline: true }
      );
    if (notice) embed.addFields({ name: "Status", value: String(notice).slice(0, 1024) });
    return embed;
  }

  const title = safeTrackDescription(track);
  const artist = escapeDiscordMarkdown(track.author || "Unknown artist");
  const progress = buildProgressBar(state.positionMs, track.durationMs, { stream: track.isStream });
  const next = state.queue.slice(0, 3);
  const queueText = next.length
    ? next.map((item, index) => `${index + 1}. ${safeTrackDescription(item)}`).join("\n").slice(0, 1024)
    : state.autoplayEnabled
      ? "No human tracks queued — related music will continue."
      : "Queue is empty.";
  const requester = /^\d{16,22}$/.test(String(track.requesterId || ""))
    ? `<@${track.requesterId}>`
    : "Unknown requester";

  embed
    .setDescription(`${title}\n**${artist}**\n\n${progress}`)
    .addFields(
      { name: "Queue", value: `${state.queue.length} track${state.queue.length === 1 ? "" : "s"}`, inline: true },
      { name: "Volume", value: state.muted ? "Muted" : `${state.volume}%`, inline: true },
      { name: "Loop", value: loopLabel(state.loopMode), inline: true },
      { name: "Autoplay", value: state.autoplayEnabled ? "Related music" : "Off", inline: true },
      { name: "Filter", value: escapeDiscordMarkdown(state.filterPreset), inline: true },
      { name: "Source", value: escapeDiscordMarkdown(sourceLabel(track)), inline: true },
      { name: "Requested By", value: requester, inline: true },
      { name: "Up Next", value: queueText }
    );

  if (track.autoplay) {
    const seed = [track.autoplaySeedAuthor, track.autoplaySeedTitle].filter(Boolean).join(" — ");
    embed.setFooter({ text: seed ? `Recommended from ${seed}`.slice(0, 2048) : "Autoplay recommendation" });
  }

  const artwork = safeHttpUrl(track.artworkUrl);
  if (artwork) embed.setThumbnail(artwork);
  if (notice) embed.addFields({ name: "Status", value: String(notice).slice(0, 1024) });
  return embed;
}

function playerButton(customId, emoji, label, style, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setEmoji(emoji)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function buildPlayerComponents(guildPlayer, { disabled = false } = {}) {
  const state = guildPlayer.snapshot();
  const hasTrack = Boolean(state.current);
  const noTrack = disabled || !state.connected || !hasTrack;
  const cannotSeek = noTrack || Boolean(state.current?.isStream);

  const transport = new ActionRowBuilder().addComponents(
    playerButton(IDS.previous, "⏮️", "Previous", ButtonStyle.Secondary, noTrack || !state.history.length),
    playerButton(IDS.rewind, "⏪", "10s", ButtonStyle.Secondary, cannotSeek),
    playerButton(
      IDS.pause,
      state.paused ? "▶️" : "⏸️",
      state.paused ? "Resume" : "Pause",
      state.paused ? ButtonStyle.Success : ButtonStyle.Primary,
      noTrack
    ),
    playerButton(IDS.forward, "⏩", "10s", ButtonStyle.Secondary, cannotSeek),
    playerButton(IDS.skip, "⏭️", "Skip", ButtonStyle.Secondary, noTrack)
  );

  const playback = new ActionRowBuilder().addComponents(
    playerButton(IDS.replay, "🔄", "Replay", ButtonStyle.Secondary, cannotSeek),
    playerButton(IDS.shuffle, "🔀", "Shuffle", ButtonStyle.Secondary, disabled || state.queue.length < 2),
    playerButton(
      IDS.loop,
      "🔁",
      `Loop: ${loopLabel(state.loopMode)}`,
      state.loopMode === "off" ? ButtonStyle.Secondary : ButtonStyle.Success,
      disabled || !state.connected
    ),
    playerButton(
      IDS.autoplay,
      "♾️",
      state.autoplayEnabled ? "Autoplay: On" : "Autoplay: Off",
      state.autoplayEnabled ? ButtonStyle.Success : ButtonStyle.Secondary,
      noTrack
    ),
    playerButton(IDS.stop, "⏹️", "Stop", ButtonStyle.Danger, noTrack && !state.queue.length)
  );

  const utility = new ActionRowBuilder().addComponents(
    playerButton(IDS.volumeDown, "🔉", "Vol -", ButtonStyle.Secondary, disabled || !state.connected),
    playerButton(
      IDS.mute,
      state.muted ? "🔊" : "🔇",
      state.muted ? "Unmute" : "Mute",
      ButtonStyle.Secondary,
      disabled || !state.connected
    ),
    playerButton(IDS.volumeUp, "🔊", "Vol +", ButtonStyle.Secondary, disabled || !state.connected),
    playerButton(IDS.queue, "📜", "Queue", ButtonStyle.Primary, disabled || !state.connected),
    playerButton(IDS.disconnect, "⏏️", "Disconnect", ButtonStyle.Danger, disabled || !state.connected)
  );

  const filter = new StringSelectMenuBuilder()
    .setCustomId(IDS.filter)
    .setPlaceholder(`Audio filter: ${state.filterPreset}`)
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled || !state.connected)
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("Clear filters").setValue("clear").setEmoji("🧹"),
      new StringSelectMenuOptionBuilder().setLabel("Bass Boost").setValue("bassboost").setEmoji("🔊"),
      new StringSelectMenuOptionBuilder().setLabel("Nightcore").setValue("nightcore").setEmoji("⚡"),
      new StringSelectMenuOptionBuilder().setLabel("Vaporwave").setValue("vaporwave").setEmoji("🌊"),
      new StringSelectMenuOptionBuilder().setLabel("Karaoke").setValue("karaoke").setEmoji("🎤"),
      new StringSelectMenuOptionBuilder().setLabel("Tremolo").setValue("tremolo").setEmoji("〰️"),
      new StringSelectMenuOptionBuilder().setLabel("Vibrato").setValue("vibrato").setEmoji("🎶"),
      new StringSelectMenuOptionBuilder().setLabel("8D Rotation").setValue("rotation").setEmoji("🌀"),
      new StringSelectMenuOptionBuilder().setLabel("Low Pass").setValue("lowpass").setEmoji("🎚️")
    );

  return [transport, playback, utility, new ActionRowBuilder().addComponents(filter)];
}

function buildPlayerPayload(guildPlayer, options = {}) {
  return {
    content: "",
    embeds: [buildPlayerEmbed(guildPlayer, options)],
    components: buildPlayerComponents(guildPlayer, options),
    allowedMentions: { parse: [] },
  };
}

function pageFromCustomId(customId) {
  const value = String(customId || "");
  if (!value.startsWith(`${IDS.queuePage}:`)) return 0;
  return Math.max(0, Number(value.slice(IDS.queuePage.length + 1)) || 0);
}

function buildQueuePayload(guildPlayer, page = 0, { notice = null } = {}) {
  const state = guildPlayer.snapshot();
  const pageCount = Math.max(1, Math.ceil(state.queue.length / QUEUE_PAGE_SIZE));
  const safePage = clamp(Math.floor(Number(page) || 0), 0, pageCount - 1);
  const offset = safePage * QUEUE_PAGE_SIZE;
  const tracks = state.queue.slice(offset, offset + QUEUE_PAGE_SIZE);
  const description = tracks.length
    ? tracks
        .map((track, index) => `**${offset + index + 1}.** ${safeTrackDescription(track)}`)
        .join("\n")
        .slice(0, 4096)
    : state.autoplayEnabled
      ? "No human-requested tracks are queued. Autoplay will select related music when needed."
      : "The queue is empty.";

  const embed = new EmbedBuilder()
    .setTitle("📜 Stoney Music Queue")
    .setDescription(description)
    .addFields(
      { name: "Now Playing", value: state.current ? safeTrackDescription(state.current) : "Nothing", inline: false },
      { name: "Page", value: `${safePage + 1}/${pageCount}`, inline: true },
      { name: "Total", value: String(state.queue.length), inline: true },
      { name: "Autoplay", value: state.autoplayEnabled ? "On" : "Off", inline: true }
    );
  if (notice) embed.addFields({ name: "Status", value: String(notice).slice(0, 1024) });

  const navigation = new ActionRowBuilder().addComponents(
    playerButton(`${IDS.queuePage}:${safePage - 1}`, "◀️", "Previous Page", ButtonStyle.Secondary, safePage <= 0),
    playerButton(`${IDS.queuePage}:${safePage + 1}`, "▶️", "Next Page", ButtonStyle.Secondary, safePage >= pageCount - 1)
  );
  const management = new ActionRowBuilder().addComponents(
    playerButton(IDS.queueRemove, "➖", "Remove", ButtonStyle.Secondary, !state.queue.length),
    playerButton(IDS.queueMove, "↕️", "Move", ButtonStyle.Secondary, state.queue.length < 2),
    playerButton(IDS.queueClear, "🧹", "Clear Queue", ButtonStyle.Danger, !state.queue.length),
    playerButton(IDS.queueShuffle, "🔀", "Shuffle", ButtonStyle.Secondary, state.queue.length < 2)
  );

  return {
    embeds: [embed],
    components: [navigation, management],
    allowedMentions: { parse: [] },
  };
}

function buildPositionModal(action) {
  const remove = action === "remove";
  const modal = new ModalBuilder()
    .setCustomId(remove ? IDS.modalRemove : IDS.modalMove)
    .setTitle(remove ? "Remove a queued track" : "Move a queued track");

  const from = new TextInputBuilder()
    .setCustomId("position")
    .setLabel(remove ? "Queue position to remove" : "Current queue position")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: 3")
    .setRequired(true)
    .setMaxLength(6);
  modal.addComponents(new ActionRowBuilder().addComponents(from));

  if (!remove) {
    const destination = new TextInputBuilder()
      .setCustomId("destination")
      .setLabel("New queue position")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Example: 1")
      .setRequired(true)
      .setMaxLength(6);
    modal.addComponents(new ActionRowBuilder().addComponents(destination));
  }
  return modal;
}

function isPlayerInteraction(interaction) {
  return String(interaction?.customId || "").startsWith(PLAYER_PREFIX);
}

function voiceChannelIdFor(interaction) {
  return interaction.member?.voice?.channelId || interaction.member?.voice?.channel?.id || null;
}

async function replyEphemeral(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

class PlayerControllerManager {
  constructor({ client, players, logger = console } = {}) {
    if (!client || !players) throw new TypeError("PlayerControllerManager requires client and players.");
    this.client = client;
    this.players = players;
    this.logger = logger;
    this.messages = new Map();
    this.attached = new WeakSet();
    this.refreshTimers = new Map();
    this.lastRefreshAt = new Map();
    this.refreshChains = new Map();
  }

  attach(guildPlayer) {
    if (!guildPlayer || this.attached.has(guildPlayer)) return;
    this.attached.add(guildPlayer);
    guildPlayer.on("stateChange", (_snapshot, reason) => {
      this.scheduleRefresh(guildPlayer.guildId, { positionOnly: reason === "position" });
    });
  }

  registerMessage(guildId, message) {
    if (!guildId || !message?.id || !message?.channelId) return;
    this.messages.set(String(guildId), {
      channelId: String(message.channelId),
      messageId: String(message.id),
    });
  }

  isCanonicalMessage(interaction) {
    const state = this.messages.get(String(interaction.guildId));
    if (!state) return false;
    return state.messageId === String(interaction.message?.id || "");
  }

  async _fetchRecordedMessage(guildId) {
    const state = this.messages.get(String(guildId));
    if (!state) return null;
    const channel = await this.client.channels.fetch(state.channelId);
    return channel?.messages?.fetch(state.messageId) || null;
  }

  async publish(interaction, guildPlayer, { notice = null } = {}) {
    this.attach(guildPlayer);
    const guildId = String(guildPlayer.guildId);

    try {
      const message = await this._fetchRecordedMessage(guildId);
      if (message) {
        await message.edit(buildPlayerPayload(guildPlayer, { notice }));
        await interaction.editReply({
          content: notice || "✅ Player updated.",
          embeds: [],
          components: [],
          allowedMentions: { parse: [] },
        });
        return message;
      }
    } catch (error) {
      this.messages.delete(guildId);
      this.logger.warn?.("Recorded player panel could not be updated; creating a new one", {
        guildId,
        message: error?.message || String(error),
      });
    }

    const message = await interaction.editReply(buildPlayerPayload(guildPlayer, { notice }));
    this.registerMessage(guildId, message);
    return message;
  }

  async show(interaction, guildPlayer) {
    this.attach(guildPlayer);
    const guildId = String(guildPlayer.guildId);
    try {
      const existing = await this._fetchRecordedMessage(guildId);
      if (existing) {
        await existing.edit(buildPlayerPayload(guildPlayer));
        const link = safeHttpUrl(existing.url);
        await interaction.reply({
          content: link ? `🎛️ Player controller refreshed: ${link}` : "🎛️ Player controller refreshed.",
          flags: MessageFlags.Ephemeral,
        });
        return existing;
      }
    } catch {
      this.messages.delete(guildId);
    }

    await interaction.reply(buildPlayerPayload(guildPlayer));
    const message = await interaction.fetchReply();
    this.registerMessage(guildId, message);
    return message;
  }

  scheduleRefresh(guildId, { positionOnly = false } = {}) {
    const id = String(guildId);
    if (!this.messages.has(id)) return;
    const elapsed = Date.now() - (this.lastRefreshAt.get(id) || 0);
    const delay = positionOnly ? Math.max(0, POSITION_REFRESH_MS - elapsed) : 0;
    const currentTimer = this.refreshTimers.get(id);
    if (currentTimer && positionOnly) return;
    if (currentTimer) clearTimeout(currentTimer);
    const timer = setTimeout(() => {
      this.refreshTimers.delete(id);
      this.refresh(id).catch((error) => {
        this.logger.warn?.("Player panel refresh failed", {
          guildId: id,
          message: error?.message || String(error),
        });
      });
    }, delay);
    timer.unref?.();
    this.refreshTimers.set(id, timer);
  }

  async refresh(guildId, { notice = null } = {}) {
    const id = String(guildId);
    const previous = this.refreshChains.get(id) || Promise.resolve();
    const run = previous.then(async () => {
      const state = this.messages.get(id);
      if (!state) return null;
      const guildPlayer = this.players.peek?.(id) || this.players.guildPlayers?.get(id);
      if (!guildPlayer) return null;
      try {
        const channel = await this.client.channels.fetch(state.channelId);
        const message = await channel?.messages?.fetch(state.messageId);
        if (!message) throw new Error("Player message no longer exists.");
        await message.edit(buildPlayerPayload(guildPlayer, { notice }));
        this.lastRefreshAt.set(id, Date.now());
        return message;
      } catch (error) {
        if ([10003, 10008].includes(Number(error?.code))) this.messages.delete(id);
        throw error;
      }
    });
    this.refreshChains.set(id, run.catch(() => {}));
    return run;
  }

  async _requireActivePlayer(interaction) {
    const guildPlayer = this.players.peek?.(interaction.guildId) || this.players.guildPlayers?.get(interaction.guildId);
    if (!guildPlayer?.isConnected()) {
      await replyEphemeral(interaction, "This player session is no longer active. Start a song to create a new controller.");
      return null;
    }
    if (voiceChannelIdFor(interaction) !== guildPlayer.voiceChannelId) {
      await replyEphemeral(interaction, "Join the same voice channel as Stoney Music to use these controls.");
      return null;
    }
    this.attach(guildPlayer);
    return guildPlayer;
  }

  async handle(interaction) {
    if (!isPlayerInteraction(interaction)) return false;
    if (!interaction.inGuild?.()) {
      await replyEphemeral(interaction, "Server only.");
      return true;
    }

    const guildPlayer = await this._requireActivePlayer(interaction);
    if (!guildPlayer) return true;
    const customId = String(interaction.customId);

    if (interaction.isModalSubmit?.()) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (customId === IDS.modalRemove) {
        const position = Number(interaction.fields.getTextInputValue("position"));
        const removed = guildPlayer.removeQueueTrack(position);
        await interaction.editReply(`➖ Removed **${escapeDiscordMarkdown(removed.title)}** from position ${position}.`);
      } else if (customId === IDS.modalMove) {
        const position = Number(interaction.fields.getTextInputValue("position"));
        const destination = Number(interaction.fields.getTextInputValue("destination"));
        const moved = guildPlayer.moveQueueTrack(position, destination);
        await interaction.editReply(
          `↕️ Moved **${escapeDiscordMarkdown(moved.title)}** from position ${position} to ${destination}.`
        );
      }
      await this.refresh(interaction.guildId);
      return true;
    }

    if (customId === IDS.queueRemove) {
      await interaction.showModal(buildPositionModal("remove"));
      return true;
    }
    if (customId === IDS.queueMove) {
      await interaction.showModal(buildPositionModal("move"));
      return true;
    }
    if (customId === IDS.queueClear) {
      await interaction.reply({
        content: `Clear all **${guildPlayer.queueLength()}** upcoming tracks?`,
        components: [
          new ActionRowBuilder().addComponents(
            playerButton(IDS.queueClearConfirm, "✅", "Clear Queue", ButtonStyle.Danger),
            playerButton(IDS.queueClearCancel, "❌", "Cancel", ButtonStyle.Secondary)
          ),
        ],
        flags: MessageFlags.Ephemeral,
      });
      return true;
    }
    if (customId === IDS.queueClearConfirm) {
      const removed = guildPlayer.clearQueue();
      await interaction.update({ content: `🧹 Cleared ${removed} queued track${removed === 1 ? "" : "s"}.`, components: [] });
      await this.refresh(interaction.guildId);
      return true;
    }
    if (customId === IDS.queueClearCancel) {
      await interaction.update({ content: "Queue clear cancelled.", components: [] });
      return true;
    }
    if (customId.startsWith(`${IDS.queuePage}:`)) {
      await interaction.update(buildQueuePayload(guildPlayer, pageFromCustomId(customId)));
      return true;
    }
    if (customId === IDS.queueShuffle) {
      const count = guildPlayer.shuffle();
      await interaction.update(buildQueuePayload(guildPlayer, 0, { notice: `Shuffled ${count} tracks.` }));
      await this.refresh(interaction.guildId, { notice: `Shuffled ${count} queued tracks.` });
      return true;
    }
    if (customId === IDS.queue) {
      await interaction.reply({ ...buildQueuePayload(guildPlayer, 0), flags: MessageFlags.Ephemeral });
      return true;
    }

    if (interaction.message && !this.isCanonicalMessage(interaction)) {
      await replyEphemeral(interaction, "That is an old player panel. Use the newest Stoney Music controller.");
      return true;
    }

    if (customId === IDS.filter && interaction.isStringSelectMenu?.()) {
      await interaction.deferUpdate();
      await guildPlayer.setFilterPreset(interaction.values[0]);
      await this.refresh(interaction.guildId, { notice: `Filter set to ${interaction.values[0]}.` });
      return true;
    }

    await interaction.deferUpdate();
    let notice = null;
    switch (customId) {
      case IDS.previous: {
        const previous = await guildPlayer.previous();
        notice = previous ? `Playing previous track: ${previous.title}` : "No previous track is available.";
        break;
      }
      case IDS.rewind:
        notice = `Seeked to ${formatDuration(await guildPlayer.seekBy(-10_000))}.`;
        break;
      case IDS.pause: {
        const paused = await guildPlayer.togglePaused();
        notice = paused ? "Playback paused." : "Playback resumed.";
        break;
      }
      case IDS.forward:
        notice = `Seeked to ${formatDuration(await guildPlayer.seekBy(10_000))}.`;
        break;
      case IDS.skip:
        notice = (await guildPlayer.skip()) ? "Skipped the current track." : "Nothing is playing.";
        break;
      case IDS.replay:
        await guildPlayer.replay();
        notice = "Replaying the current track.";
        break;
      case IDS.shuffle:
        notice = `Shuffled ${guildPlayer.shuffle()} queued tracks.`;
        break;
      case IDS.loop:
        notice = `Loop mode: ${await guildPlayer.cycleLoop()}.`;
        break;
      case IDS.autoplay: {
        const enabled = await guildPlayer.setAutoplay(!guildPlayer.autoplayStatus());
        notice = enabled ? "Autoplay will continue with related music." : "Autoplay disabled.";
        break;
      }
      case IDS.stop:
        await guildPlayer.stopAndClear();
        notice = "Stopped playback, cleared the queue, and disabled autoplay.";
        break;
      case IDS.volumeDown:
        notice = `Volume: ${await guildPlayer.adjustVolume(-10)}%.`;
        break;
      case IDS.mute:
        notice = `Volume: ${await guildPlayer.toggleMute()}%.`;
        break;
      case IDS.volumeUp:
        notice = `Volume: ${await guildPlayer.adjustVolume(10)}%.`;
        break;
      case IDS.disconnect:
        await guildPlayer.disconnect();
        notice = "Disconnected and cleared the player session.";
        break;
      default:
        await replyEphemeral(interaction, "That player control is no longer supported.");
        return true;
    }

    await this.refresh(interaction.guildId, { notice });
    return true;
  }
}

module.exports = {
  IDS,
  PLAYER_PREFIX,
  PlayerControllerManager,
  buildPlayerComponents,
  buildPlayerEmbed,
  buildPlayerPayload,
  buildPositionModal,
  buildProgressBar,
  buildQueuePayload,
  formatDuration,
  isPlayerInteraction,
  pageFromCustomId,
  voiceChannelIdFor,
};
