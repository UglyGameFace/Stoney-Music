"use strict";

class GuildPlayer {
  constructor(shoukaku, guildId, { logger = console, resolveFallback = null } = {}) {
    this.shoukaku = shoukaku;
    this.guildId = guildId;
    this.logger = logger;
    this.resolveFallback = typeof resolveFallback === "function" ? resolveFallback : null;

    this.player = null;
    this.voiceChannelId = null;
    this.queue = [];
    this.current = null;

    this.volume = 100;
    this.loopMode = "off";
    this._transition = Promise.resolve();
    this._eventsBound = false;
  }

  _toLavalinkVolume(volume) {
    return Math.max(0, Math.min(1000, Math.round(volume)));
  }

  _serialize(operation) {
    const run = this._transition.then(operation, operation);
    this._transition = run.catch(() => {});
    return run;
  }

  _shortErrorMessage(event) {
    const raw = event?.exception?.message || event?.message || "Unknown playback exception";
    return String(raw).split(/\r?\n/, 1)[0].slice(0, 500);
  }

  _scheduleExceptionStop(failedEncoded) {
    // Lavalink normally follows an exception with a loadFailed end event. This
    // watchdog is only for providers that emit the exception but never terminate
    // the track, and it cannot stop a replacement or a newly advanced queue item.
    const recovery = setTimeout(() => {
      if (!failedEncoded || this.current?.encoded !== failedEncoded || !this.player) return;
      this.player.stopTrack().catch((error) => {
        this.logger.error?.("Failed to stop an unrecoverable track exception", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    }, 1_000);
    recovery.unref?.();
  }

  async connect({ guildId, voiceChannelId, shardId, deaf = true, mute = false }) {
    if (this.player) {
      if (this.voiceChannelId !== voiceChannelId) {
        throw new Error("The bot is already connected to another voice channel.");
      }
      return this.player;
    }

    this.player = await this.shoukaku.joinVoiceChannel({
      guildId,
      channelId: voiceChannelId,
      shardId,
      deaf,
      mute,
    });
    this.voiceChannelId = voiceChannelId;
    this._bindPlayerEvents();
    await this.player.setGlobalVolume(this._toLavalinkVolume(this.volume));
    return this.player;
  }

  _bindPlayerEvents() {
    if (!this.player || this._eventsBound) return;
    this._eventsBound = true;

    this.player.on("end", (event) => {
      this._handleTrackEnd(event).catch((error) => {
        this.logger.error?.("Track-end transition failed", {
          guildId: this.guildId,
          reason: event?.reason,
          message: error?.message || String(error),
        });
      });
    });

    this.player.on("exception", (event) => {
      this._handleTrackException(event).catch((error) => {
        this.logger.error?.("Track-exception recovery failed", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    });

    this.player.on("stuck", (event) => {
      this.logger.warn?.("Lavalink track stuck; requesting a stop so the queue can advance", {
        guildId: this.guildId,
        thresholdMs: event?.thresholdMs,
      });
      this.player.stopTrack().catch((error) => {
        this.logger.error?.("Failed to stop stuck track", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    });
  }

  isConnected() {
    return Boolean(this.player);
  }

  isInVoiceChannel(channelId) {
    return this.isConnected() && this.voiceChannelId === channelId;
  }

  enqueue(track) {
    this.queue.push(track);
    return this.queue.length;
  }

  enqueueMany(tracks) {
    for (const track of tracks) this.enqueue(track);
    return this.queue.length;
  }

  nowPlaying() {
    return this.current;
  }

  getQueuePreview(limit = 10) {
    return this.queue.slice(0, limit);
  }

  queueLength() {
    return this.queue.length;
  }

  async _startTrack(track) {
    if (!this.player) throw new Error("Not connected.");
    this.current = track;
    try {
      await this.player.playTrack({ track: { encoded: track.encoded } });
      await this.player.setGlobalVolume(this._toLavalinkVolume(this.volume));
      return track;
    } catch (error) {
      if (this.current === track) this.current = null;
      throw error;
    }
  }

  async playNext() {
    return this._serialize(async () => {
      if (!this.player) throw new Error("Not connected.");
      if (this.current) return this.current;
      const next = this.queue.shift();
      if (!next) return null;
      return this._startTrack(next);
    });
  }

  async skip() {
    if (!this.player) throw new Error("Not connected.");
    if (!this.current) return false;
    await this.player.stopTrack();
    return true;
  }

  async stopAndClear() {
    if (!this.player) throw new Error("Not connected.");
    this.queue = [];
    const hadCurrent = Boolean(this.current);
    this.current = null;
    if (hadCurrent) await this.player.stopTrack();
    return hadCurrent;
  }

  async setVolume(volume) {
    this.volume = Math.max(0, Math.min(200, volume));
    if (this.player) {
      await this.player.setGlobalVolume(this._toLavalinkVolume(this.volume));
    }
    return this.volume;
  }

  async setLoop(mode) {
    if (!["off", "track", "queue"].includes(mode)) {
      throw new Error("Unknown loop mode.");
    }
    this.loopMode = mode;
    return this.loopMode;
  }

  async setFilterPreset(preset) {
    if (!this.player) throw new Error("Not connected.");

    const filters = {};
    if (preset === "bassboost") {
      filters.equalizer = [
        { band: 0, gain: 0.35 },
        { band: 1, gain: 0.25 },
        { band: 2, gain: 0.15 },
      ];
    } else if (preset === "nightcore") {
      filters.timescale = { speed: 1.15, pitch: 1.2, rate: 1.0 };
    } else if (preset === "vaporwave") {
      filters.timescale = { speed: 0.85, pitch: 0.9, rate: 1.0 };
    } else if (preset !== "clear") {
      throw new Error("Unknown preset.");
    }

    await this.player.setFilters(filters);
    return preset;
  }

  async _handleTrackException(event = {}) {
    return this._serialize(async () => {
      if (!this.player || !this.current) return null;

      const failedEncoded = event?.track?.encoded || this.current.encoded;
      if (failedEncoded && failedEncoded !== this.current.encoded) {
        this.logger.warn?.("Ignoring stale Lavalink exception event", {
          guildId: this.guildId,
        });
        return this.current;
      }

      const failed = this.current;
      const failureMessage = this._shortErrorMessage(event);
      this.logger.warn?.("⚠️ Playback source failed", {
        guildId: this.guildId,
        title: failed.title,
        source: failed.sourceName,
        message: failureMessage,
      });

      if (this.resolveFallback && !failed.fallbackAttempted) {
        // Mark first so duplicate exception events cannot launch parallel searches.
        failed.fallbackAttempted = true;
        try {
          const fallback = await this.resolveFallback(failed);

          // A moderator may have stopped/skipped playback while the provider search
          // was running. Never resurrect a track whose state has already changed.
          if (!this.player || this.current !== failed) return this.current;

          if (fallback?.track) {
            const replacement = fallback.track;
            replacement.fallbackAttempted = true;
            try {
              const started = await this._startTrack(replacement);
              this.logger.log?.("🔁 Recovered blocked playback through another provider", {
                guildId: this.guildId,
                originalTitle: failed.title,
                replacementTitle: replacement.title,
                source: fallback.source || replacement.sourceName,
                score: Number(fallback.score || 0).toFixed(3),
              });
              return started;
            } catch (error) {
              // _startTrack clears current when the replacement itself cannot start.
              // Restore the failed identity so the watchdog/end event can advance once.
              if (!this.current) this.current = failed;
              this.logger.warn?.("Playback fallback candidate could not start", {
                guildId: this.guildId,
                source: fallback.source || replacement.sourceName,
                message: error?.message || String(error),
              });
            }
          } else {
            this.logger.warn?.("No safe playback fallback match was found", {
              guildId: this.guildId,
              title: failed.title,
              bestScore: Number(fallback?.score || 0).toFixed(3),
              attempts: fallback?.attempts,
            });
          }
        } catch (error) {
          if (!this.player || this.current !== failed) return this.current;
          this.logger.warn?.("Playback fallback search failed", {
            guildId: this.guildId,
            title: failed.title,
            message: error?.message || String(error),
          });
        }
      }

      this._scheduleExceptionStop(failedEncoded);
      return this.current;
    });
  }

  async _handleTrackEnd(event = {}) {
    return this._serialize(async () => {
      if (!this.player || !this.current) return null;

      const reason = String(event.reason || "finished");
      const endedEncoded = event?.track?.encoded;
      if (endedEncoded && endedEncoded !== this.current.encoded) {
        this.logger.warn?.("Ignoring stale Lavalink end event", {
          guildId: this.guildId,
          reason,
        });
        return this.current;
      }
      if (reason === "replaced") return this.current;

      const finished = this.current;
      this.current = null;

      if (reason === "cleanup") {
        return null;
      }

      if (reason === "finished") {
        if (this.loopMode === "track") {
          return this._startTrack(finished);
        }
        if (this.loopMode === "queue") {
          this.queue.push(finished);
        }
      }

      // stopped (manual skip), loadFailed, and unknown terminal reasons never
      // replay the failed/skipped item. They advance once through this path.
      const next = this.queue.shift();
      if (!next) return null;
      return this._startTrack(next);
    });
  }
}

module.exports = { GuildPlayer };
