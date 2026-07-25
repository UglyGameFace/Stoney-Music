"use strict";

const { EventEmitter } = require("node:events");
const { canonicalTrackKey } = require("./autoplay");

const FILTER_PRESETS = Object.freeze({
  clear: {},
  bassboost: {
    equalizer: [
      { band: 0, gain: 0.35 },
      { band: 1, gain: 0.25 },
      { band: 2, gain: 0.15 },
    ],
  },
  nightcore: { timescale: { speed: 1.15, pitch: 1.2, rate: 1.0 } },
  vaporwave: { timescale: { speed: 0.85, pitch: 0.9, rate: 1.0 } },
  karaoke: { karaoke: { level: 1.0, monoLevel: 1.0, filterBand: 220.0, filterWidth: 100.0 } },
  tremolo: { tremolo: { frequency: 4.0, depth: 0.75 } },
  vibrato: { vibrato: { frequency: 4.0, depth: 0.75 } },
  rotation: { rotation: { rotationHz: 0.2 } },
  lowpass: { lowPass: { smoothing: 20.0 } },
});

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

class GuildPlayer extends EventEmitter {
  constructor(
    shoukaku,
    guildId,
    { logger = console, resolveFallback = null, resolveAutoplay = null } = {}
  ) {
    super();
    this.shoukaku = shoukaku;
    this.guildId = guildId;
    this.logger = logger;
    this.resolveFallback = typeof resolveFallback === "function" ? resolveFallback : null;
    this.resolveAutoplay = typeof resolveAutoplay === "function" ? resolveAutoplay : null;

    this.player = null;
    this.voiceChannelId = null;
    this.queue = [];
    this.current = null;
    this.history = [];

    this.volume = 100;
    this.previousVolume = 100;
    this.loopMode = "off";
    this.filterPreset = "clear";
    this.autoplayEnabled = false;
    this.autoplaySeed = null;

    this._autoplayRevision = 0;
    this._autoplayPrefetch = null;
    this._transition = Promise.resolve();
    this._eventsBound = false;
    this._boundPlayer = null;
  }

  _toLavalinkVolume(volume) {
    return clamp(Math.round(volume), 0, 1000);
  }

  _serialize(operation) {
    const run = this._transition.then(operation, operation);
    this._transition = run.catch(() => {});
    return run;
  }

  _notify(reason) {
    try {
      this.emit("stateChange", this.snapshot(), reason);
    } catch (error) {
      this.logger.warn?.("Player state listener failed", {
        guildId: this.guildId,
        reason,
        message: error?.message || String(error),
      });
    }
  }

  snapshot() {
    return {
      guildId: this.guildId,
      connected: this.isConnected(),
      voiceChannelId: this.voiceChannelId,
      current: this.current,
      queue: [...this.queue],
      history: [...this.history],
      positionMs: Math.max(0, Number(this.player?.position || 0)),
      paused: Boolean(this.player?.paused),
      volume: this.volume,
      muted: this.volume === 0,
      loopMode: this.loopMode,
      filterPreset: this.filterPreset,
      autoplayEnabled: this.autoplayEnabled,
    };
  }

  _shortErrorMessage(event) {
    const raw = event?.exception?.message || event?.message || "Unknown playback exception";
    return String(raw).split(/\r?\n/, 1)[0].slice(0, 500);
  }

  _scheduleExceptionStop(failedEncoded) {
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

  _invalidateAutoplayPrefetch() {
    this._autoplayRevision += 1;
    this._autoplayPrefetch = null;
  }

  _rememberTrack(track) {
    if (!track) return;
    const key = canonicalTrackKey(track);
    const last = this.history.at(-1);
    if (!last || canonicalTrackKey(last) !== key) this.history.push(track);
    if (this.history.length > 50) this.history.splice(0, this.history.length - 50);
  }

  _primeAutoplay() {
    if (
      !this.autoplayEnabled ||
      !this.resolveAutoplay ||
      !this.player ||
      !this.current ||
      this.queue.length
    ) {
      return null;
    }

    const seed = this.autoplaySeed || this.current;
    const seedKey = canonicalTrackKey(seed);
    const currentEncoded = this.current.encoded;
    const revision = this._autoplayRevision;

    if (
      this._autoplayPrefetch?.revision === revision &&
      this._autoplayPrefetch?.seedKey === seedKey &&
      this._autoplayPrefetch?.currentEncoded === currentEncoded
    ) {
      return this._autoplayPrefetch.promise;
    }

    const promise = Promise.resolve()
      .then(() =>
        this.resolveAutoplay(seed, {
          history: [...this.history],
          queue: [...this.queue],
          current: this.current,
        })
      )
      .catch((error) => {
        this.logger.warn?.("Autoplay prefetch failed", {
          guildId: this.guildId,
          title: seed?.title,
          artist: seed?.author,
          message: error?.message || String(error),
        });
        return null;
      });

    this._autoplayPrefetch = { revision, seedKey, currentEncoded, promise };
    return promise;
  }

  async _resolveAutoplayTrack(finished) {
    if (!this.autoplayEnabled || !this.resolveAutoplay || !this.player) return null;

    const seed = this.autoplaySeed || finished;
    if (!seed) return null;
    const seedKey = canonicalTrackKey(seed);
    const revision = this._autoplayRevision;
    const prefetched =
      this._autoplayPrefetch?.revision === revision &&
      this._autoplayPrefetch?.seedKey === seedKey
        ? this._autoplayPrefetch.promise
        : null;

    const result = await (
      prefetched ||
      this.resolveAutoplay(seed, {
        history: [...this.history],
        queue: [...this.queue],
        current: null,
      })
    );

    if (!this.player || !this.autoplayEnabled || revision !== this._autoplayRevision) return null;
    const track = result?.track || null;
    if (!track) {
      this.logger.warn?.("Autoplay could not find a safe related track", {
        guildId: this.guildId,
        seedTitle: seed.title,
        seedArtist: seed.author,
      });
      return null;
    }

    track.autoplay = true;
    track.autoplaySeedTitle ||= seed.title || "";
    track.autoplaySeedAuthor ||= seed.author || "";
    this.logger.log?.("♾️ Autoplay selected a related track", {
      guildId: this.guildId,
      seedTitle: seed.title,
      seedArtist: seed.author,
      selectedTitle: track.title,
      selectedArtist: track.author,
      provider: result.recommendationProvider || track.autoplayProvider || result.source,
      score: Number(result.score || track.autoplayScore || 0).toFixed(3),
    });
    return track;
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
    this._notify("connected");
    return this.player;
  }

  _bindPlayerEvents() {
    if (!this.player || (this._eventsBound && this._boundPlayer === this.player)) return;
    this._eventsBound = true;
    this._boundPlayer = this.player;
    const bound = this.player;

    bound.on("start", () => {
      if (this.player !== bound) return;
      this._notify("trackStart");
    });

    bound.on("update", () => {
      if (this.player !== bound) return;
      this._notify("position");
    });

    bound.on("end", (event) => {
      if (this.player !== bound) return;
      this._handleTrackEnd(event).catch((error) => {
        this.logger.error?.("Track-end transition failed", {
          guildId: this.guildId,
          reason: event?.reason,
          message: error?.message || String(error),
        });
      });
    });

    bound.on("exception", (event) => {
      if (this.player !== bound) return;
      this._handleTrackException(event).catch((error) => {
        this.logger.error?.("Track-exception recovery failed", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    });

    bound.on("stuck", (event) => {
      if (this.player !== bound) return;
      this.logger.warn?.("Lavalink track stuck; requesting a stop so the queue can advance", {
        guildId: this.guildId,
        thresholdMs: event?.thresholdMs,
      });
      bound.stopTrack().catch((error) => {
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
    if (!track) throw new TypeError("A track is required.");
    if (track.autoplay !== true) track.autoplay = false;
    this.queue.push(track);
    if (this.queue.length === 1 && this._autoplayPrefetch) this._invalidateAutoplayPrefetch();
    this._notify("queueAdd");
    return this.queue.length;
  }

  enqueueMany(tracks) {
    for (const track of tracks) this.enqueue(track);
    return this.queue.length;
  }

  nowPlaying() {
    return this.current;
  }

  getQueuePreview(limit = 10, offset = 0) {
    const safeOffset = Math.max(0, Number(offset) || 0);
    const safeLimit = Math.max(0, Number(limit) || 0);
    return this.queue.slice(safeOffset, safeOffset + safeLimit);
  }

  getHistoryPreview(limit = 10) {
    return this.history.slice(-Math.max(0, limit)).reverse();
  }

  queueLength() {
    return this.queue.length;
  }

  autoplayStatus() {
    return this.autoplayEnabled;
  }

  async setAutoplay(enabled) {
    this.autoplayEnabled = Boolean(enabled);
    this._invalidateAutoplayPrefetch();
    if (this.autoplayEnabled) this._primeAutoplay();
    this._notify("autoplay");
    return this.autoplayEnabled;
  }

  async _startTrack(track) {
    if (!this.player) throw new Error("Not connected.");
    this.current = track;
    if (!track.autoplay) {
      this.autoplaySeed = track;
      this._invalidateAutoplayPrefetch();
    }
    try {
      await this.player.playTrack({ track: { encoded: track.encoded } });
      await this.player.setGlobalVolume(this._toLavalinkVolume(this.volume));
      this._notify("trackStart");
      this._primeAutoplay();
      return track;
    } catch (error) {
      if (this.current === track) this.current = null;
      this._notify("trackStartFailed");
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
    this._notify("skip");
    return true;
  }

  async stopAndClear() {
    if (!this.player) throw new Error("Not connected.");
    this.queue = [];
    this.autoplayEnabled = false;
    this._invalidateAutoplayPrefetch();
    const hadCurrent = Boolean(this.current);
    this.current = null;
    if (hadCurrent) await this.player.stopTrack();
    this._notify("stop");
    return hadCurrent;
  }

  async disconnect() {
    const wasConnected = this.isConnected();
    this.queue = [];
    this.current = null;
    this.autoplayEnabled = false;
    this.autoplaySeed = null;
    this._invalidateAutoplayPrefetch();
    if (wasConnected) await this.shoukaku.leaveVoiceChannel(this.guildId);
    this.player = null;
    this.voiceChannelId = null;
    this._eventsBound = false;
    this._boundPlayer = null;
    this._notify("disconnect");
    return wasConnected;
  }

  async setPaused(paused) {
    if (!this.player || !this.current) return false;
    await this.player.setPaused(Boolean(paused));
    this.player.paused = Boolean(paused);
    this._notify(paused ? "pause" : "resume");
    return this.player.paused;
  }

  async togglePaused() {
    return this.setPaused(!Boolean(this.player?.paused));
  }

  async seekTo(positionMs) {
    if (!this.player || !this.current) throw new Error("Nothing is currently playing.");
    if (this.current.isStream) throw new Error("Live streams cannot be seeked.");
    const duration = Math.max(0, Number(this.current.durationMs || 0));
    const upper = duration > 0 ? Math.max(0, duration - 250) : Number.MAX_SAFE_INTEGER;
    const target = clamp(Math.round(Number(positionMs) || 0), 0, upper);
    await this.player.seekTo(target);
    this.player.position = target;
    this._notify("seek");
    return target;
  }

  async seekBy(deltaMs) {
    const currentPosition = Math.max(0, Number(this.player?.position || 0));
    return this.seekTo(currentPosition + Number(deltaMs || 0));
  }

  async replay() {
    if (!this.current) return false;
    await this.seekTo(0);
    if (this.player?.paused) await this.setPaused(false);
    this._notify("replay");
    return true;
  }

  async previous() {
    return this._serialize(async () => {
      if (!this.player) throw new Error("Not connected.");
      const previous = this.history.pop();
      if (!previous) return null;
      if (this.current) this.queue.unshift(this.current);
      const started = await this._startTrack(previous);
      this._notify("previous");
      return started;
    });
  }

  shuffle(random = Math.random) {
    for (let index = this.queue.length - 1; index > 0; index -= 1) {
      const swapWith = Math.floor(clamp(Number(random()) || 0, 0, 0.999999999) * (index + 1));
      [this.queue[index], this.queue[swapWith]] = [this.queue[swapWith], this.queue[index]];
    }
    this._invalidateAutoplayPrefetch();
    this._notify("shuffle");
    return this.queue.length;
  }

  removeQueueTrack(position) {
    const index = Number(position) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) {
      throw new RangeError("Queue position is out of range.");
    }
    const [removed] = this.queue.splice(index, 1);
    this._invalidateAutoplayPrefetch();
    this._notify("queueRemove");
    return removed;
  }

  moveQueueTrack(fromPosition, toPosition) {
    const from = Number(fromPosition) - 1;
    const to = Number(toPosition) - 1;
    if (!Number.isInteger(from) || from < 0 || from >= this.queue.length) {
      throw new RangeError("Source queue position is out of range.");
    }
    if (!Number.isInteger(to) || to < 0 || to >= this.queue.length) {
      throw new RangeError("Destination queue position is out of range.");
    }
    const [track] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, track);
    this._invalidateAutoplayPrefetch();
    this._notify("queueMove");
    return track;
  }

  clearQueue() {
    const removed = this.queue.length;
    this.queue = [];
    this._invalidateAutoplayPrefetch();
    if (this.autoplayEnabled) this._primeAutoplay();
    this._notify("queueClear");
    return removed;
  }

  async setVolume(volume) {
    const next = clamp(Math.round(Number(volume) || 0), 0, 200);
    if (next > 0) this.previousVolume = next;
    this.volume = next;
    if (this.player) {
      await this.player.setGlobalVolume(this._toLavalinkVolume(this.volume));
      this.player.volume = this._toLavalinkVolume(this.volume);
    }
    this._notify("volume");
    return this.volume;
  }

  async adjustVolume(delta) {
    return this.setVolume(this.volume + Number(delta || 0));
  }

  async toggleMute() {
    if (this.volume > 0) {
      this.previousVolume = this.volume;
      return this.setVolume(0);
    }
    return this.setVolume(this.previousVolume > 0 ? this.previousVolume : 100);
  }

  async setLoop(mode) {
    if (!["off", "track", "queue"].includes(mode)) {
      throw new Error("Unknown loop mode.");
    }
    this.loopMode = mode;
    this._notify("loop");
    return this.loopMode;
  }

  async cycleLoop() {
    const modes = ["off", "track", "queue"];
    const next = modes[(modes.indexOf(this.loopMode) + 1) % modes.length];
    return this.setLoop(next);
  }

  async setFilterPreset(preset) {
    if (!this.player) throw new Error("Not connected.");
    if (!Object.prototype.hasOwnProperty.call(FILTER_PRESETS, preset)) {
      throw new Error("Unknown preset.");
    }

    if (preset === "clear" && typeof this.player.clearFilters === "function") {
      await this.player.clearFilters();
    } else {
      await this.player.setFilters(FILTER_PRESETS[preset]);
    }
    this.filterPreset = preset;
    this._notify("filter");
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
        failed.fallbackAttempted = true;
        try {
          const fallback = await this.resolveFallback(failed);
          if (!this.player || this.current !== failed) return this.current;

          if (fallback?.track) {
            const replacement = fallback.track;
            replacement.fallbackAttempted = true;
            replacement.autoplay = Boolean(failed.autoplay);
            replacement.autoplayProvider ||= failed.autoplayProvider;
            replacement.autoplaySeedTitle ||= failed.autoplaySeedTitle;
            replacement.autoplaySeedAuthor ||= failed.autoplaySeedAuthor;
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
      this._notify("exception");
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
        this._notify("cleanup");
        return null;
      }

      if (reason === "finished" && this.loopMode === "track") {
        return this._startTrack(finished);
      }

      if (reason === "finished" || reason === "stopped") this._rememberTrack(finished);
      if (reason === "finished" && this.loopMode === "queue") this.queue.push(finished);

      let next = this.queue.shift();
      if (next) return this._startTrack(next);

      const recommended = await this._resolveAutoplayTrack(finished);
      next = this.queue.shift();
      if (next) return this._startTrack(next);
      if (recommended) return this._startTrack(recommended);

      this._notify("idle");
      return null;
    });
  }
}

module.exports = { FILTER_PRESETS, GuildPlayer };
