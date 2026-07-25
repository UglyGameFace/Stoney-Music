"use strict";

const { GuildPlayer } = require("./guild-player");
const { playbackCandidateKey } = require("./playback-fallback");

const MAX_RUNTIME_FALLBACK_ATTEMPTS = 8;
const DEFAULT_PLAYBACK_START_TIMEOUT_MS = 12_000;
const PLAYBACK_ENGINE_BUILD = "resilient-v3-start-watchdog";

function uniqueKeys(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

class ResilientGuildPlayer extends GuildPlayer {
  constructor(
    shoukaku,
    guildId,
    {
      logger = console,
      resolveFallback = null,
      resolveAutoplay = null,
      onFallbackVerified = null,
      onFallbackFailed = null,
      playbackStartTimeoutMs = DEFAULT_PLAYBACK_START_TIMEOUT_MS,
    } = {}
  ) {
    super(shoukaku, guildId, { logger, resolveFallback, resolveAutoplay });
    this.onFallbackVerified =
      typeof onFallbackVerified === "function" ? onFallbackVerified : null;
    this.onFallbackFailed = typeof onFallbackFailed === "function" ? onFallbackFailed : null;
    this.playbackStartTimeoutMs = Math.max(
      10,
      Number(playbackStartTimeoutMs) || DEFAULT_PLAYBACK_START_TIMEOUT_MS
    );
    this._fallbackBoundPlayer = null;
    this._playbackStartRevision = 0;
    this._playbackStartState = null;
  }

  async connect(options) {
    const player = await super.connect(options);
    this._bindFallbackVerification(player);
    return player;
  }

  _clearPlaybackStartWatchdog(encoded = null) {
    const state = this._playbackStartState;
    if (!state) return false;
    if (encoded && state.encoded && encoded !== state.encoded) return false;
    if (state.timer) clearTimeout(state.timer);
    this._playbackStartState = null;
    return true;
  }

  _schedulePlaybackStartWatchdog(track, revision) {
    const pending = this._playbackStartState;
    if (
      !pending ||
      pending.revision !== revision ||
      pending.encoded !== track?.encoded ||
      !this.player ||
      this.current !== track
    ) {
      return;
    }

    const timeoutMs = this.playbackStartTimeoutMs;
    const timer = setTimeout(() => {
      const active = this._playbackStartState;
      if (
        !active ||
        active.revision !== revision ||
        active.encoded !== track.encoded ||
        !this.player ||
        this.current?.encoded !== track.encoded
      ) {
        return;
      }

      this._playbackStartState = null;
      this.logger.warn?.("⏱️ Lavalink did not confirm playback start; forcing mirror recovery", {
        guildId: this.guildId,
        requestedTitle: track.title,
        requestedArtist: track.author,
        playbackTitle: track.playbackCandidateTitle || track.title,
        playbackArtist: track.playbackCandidateAuthor || track.author,
        source: track.sourceName,
        timeoutMs,
      });

      this._handleTrackException({
        track: { encoded: track.encoded },
        exception: {
          message: `Lavalink did not emit a track-start event within ${timeoutMs}ms.`,
        },
        watchdog: true,
      }).catch((error) => {
        this.logger.error?.("Playback start watchdog recovery failed", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    }, timeoutMs);
    timer.unref?.();
    pending.timer = timer;
  }

  async _startTrack(track) {
    this._clearPlaybackStartWatchdog();
    const revision = ++this._playbackStartRevision;
    this._playbackStartState = {
      revision,
      encoded: track?.encoded || null,
      timer: null,
    };

    try {
      const started = await super._startTrack(track);
      this._schedulePlaybackStartWatchdog(track, revision);
      return started;
    } catch (error) {
      const pending = this._playbackStartState;
      if (pending?.revision === revision) this._clearPlaybackStartWatchdog();
      throw error;
    }
  }

  _bindFallbackVerification(bound) {
    if (!bound || this._fallbackBoundPlayer === bound) return;
    this._fallbackBoundPlayer = bound;

    bound.on("start", (event = {}) => {
      if (this.player !== bound || !this.current) return;
      const startedEncoded = event?.track?.encoded;
      if (startedEncoded && startedEncoded !== this.current.encoded) return;

      this._clearPlaybackStartWatchdog(this.current.encoded);
      if (!this.current.fallbackPending) return;

      const confirmed = this.current;
      confirmed.fallbackPending = false;
      confirmed.fallbackVerified = true;
      this.logger.log?.("✅ Playback mirror confirmed by Lavalink", {
        guildId: this.guildId,
        requestedTitle: confirmed.title,
        requestedArtist: confirmed.author,
        playbackTitle: confirmed.playbackCandidateTitle,
        playbackArtist: confirmed.playbackCandidateAuthor,
        source: confirmed.sourceName,
        score: Number(confirmed.fallbackScore || 0).toFixed(3),
      });
      Promise.resolve(this.onFallbackVerified?.(confirmed)).catch((error) => {
        this.logger.warn?.("Could not remember a proven playback mirror", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
      this._notify("fallbackVerified");
    });
  }

  _copyRuntimeState(failed, replacement, remainingCandidates, triedKeys) {
    const identity = failed.playbackIdentity ? { ...failed.playbackIdentity } : null;
    const candidateTitle = replacement.playbackCandidateTitle || replacement.title;
    const candidateAuthor = replacement.playbackCandidateAuthor || replacement.author;

    replacement.playbackCandidateTitle = candidateTitle;
    replacement.playbackCandidateAuthor = candidateAuthor;
    replacement.playbackIdentity = identity;
    replacement.title = identity?.title || failed.title || replacement.title;
    replacement.author = identity?.artist || failed.author || replacement.author;
    replacement.artworkUrl = identity?.artworkUrl || failed.artworkUrl || replacement.artworkUrl;
    replacement.durationMs = identity?.durationMs || failed.durationMs || replacement.durationMs;
    replacement.requestedQuery =
      identity?.requestedQuery || failed.requestedQuery || replacement.requestedQuery || "";
    replacement.originalTitle = failed.originalTitle || failed.title || replacement.title;
    replacement.originalUri =
      failed.originalUri || identity?.sourceUrl || failed.uri || replacement.uri || "";
    replacement.fallbackFrom = failed.fallbackFrom || failed.sourceName || "unknown";
    replacement.autoplay = Boolean(failed.autoplay);
    replacement.autoplayProvider ||= failed.autoplayProvider;
    replacement.autoplaySeedTitle ||= failed.autoplaySeedTitle;
    replacement.autoplaySeedAuthor ||= failed.autoplaySeedAuthor;
    replacement.fallbackAttemptCount = Number(failed.fallbackAttemptCount || 0) + 1;
    replacement.fallbackTriedKeys = uniqueKeys(triedKeys);
    replacement.fallbackCandidates = remainingCandidates;
    replacement.fallbackPlanResolved = true;
    replacement.fallbackPending = true;
    replacement.fallbackVerified = false;
    replacement.isFallback = true;
    return replacement;
  }

  async _markFallbackFailed(track, reason) {
    if (!track) return;
    track.fallbackPending = false;
    track.fallbackVerified = false;
    try {
      await this.onFallbackFailed?.(track, reason);
    } catch (error) {
      this.logger.warn?.("Could not remember a dead playback mirror", {
        guildId: this.guildId,
        message: error?.message || String(error),
      });
    }
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

      this._clearPlaybackStartWatchdog(failedEncoded);
      const failed = this.current;
      const failureMessage = this._shortErrorMessage(event);
      this.logger.warn?.("⚠️ Playback source failed", {
        guildId: this.guildId,
        requestedTitle: failed.title,
        requestedArtist: failed.author,
        playbackTitle: failed.playbackCandidateTitle || failed.title,
        playbackArtist: failed.playbackCandidateAuthor || failed.author,
        source: failed.sourceName,
        message: failureMessage,
        watchdog: Boolean(event.watchdog),
      });

      if (failed.isFallback || failed.fallbackPending || failed.fallbackVerified) {
        await this._markFallbackFailed(failed, failureMessage);
      }

      const failedKey = playbackCandidateKey(failed);
      const triedKeys = uniqueKeys([...(failed.fallbackTriedKeys || []), failedKey]);
      let candidates = Array.isArray(failed.fallbackCandidates)
        ? [...failed.fallbackCandidates]
        : [];
      let planResolved = Boolean(failed.fallbackPlanResolved);
      let fallbackResult = null;

      if (
        this.resolveFallback &&
        !planResolved &&
        Number(failed.fallbackAttemptCount || 0) < MAX_RUNTIME_FALLBACK_ATTEMPTS
      ) {
        try {
          fallbackResult = await this.resolveFallback(failed, { triedKeys });
          if (!this.player || this.current !== failed) return this.current;
          candidates = Array.isArray(fallbackResult?.candidates)
            ? [...fallbackResult.candidates]
            : fallbackResult?.track
              ? [fallbackResult.track]
              : [];
          planResolved = true;
        } catch (error) {
          if (!this.player || this.current !== failed) return this.current;
          planResolved = true;
          this.logger.warn?.("Playback mirror search failed", {
            guildId: this.guildId,
            requestedTitle: failed.title,
            message: error?.message || String(error),
          });
        }
      }

      while (
        candidates.length &&
        Number(failed.fallbackAttemptCount || 0) < MAX_RUNTIME_FALLBACK_ATTEMPTS
      ) {
        const replacement = candidates.shift();
        const replacementKey = playbackCandidateKey(replacement);
        if (!replacementKey || triedKeys.includes(replacementKey)) continue;

        const nextTried = uniqueKeys([...triedKeys, replacementKey]);
        this._copyRuntimeState(failed, replacement, [...candidates], nextTried);
        this.logger.log?.("🔄 Trying strict playback mirror", {
          guildId: this.guildId,
          requestedTitle: replacement.title,
          requestedArtist: replacement.author,
          playbackTitle: replacement.playbackCandidateTitle,
          playbackArtist: replacement.playbackCandidateAuthor,
          source: replacement.sourceName,
          remainingCandidates: candidates.length,
          score: Number(replacement.fallbackScore || fallbackResult?.score || 0).toFixed(3),
        });

        try {
          return await this._startTrack(replacement);
        } catch (error) {
          await this._markFallbackFailed(replacement, error?.message || String(error));
          this.logger.warn?.("Playback mirror could not be started; trying the next candidate", {
            guildId: this.guildId,
            source: replacement.sourceName,
            playbackTitle: replacement.playbackCandidateTitle,
            message: error?.message || String(error),
          });
          if (!this.player) return null;
          this.current = failed;
          failed.fallbackAttemptCount = replacement.fallbackAttemptCount;
          failed.fallbackTriedKeys = nextTried;
          failed.fallbackCandidates = [...candidates];
          failed.fallbackPlanResolved = planResolved;
        }
      }

      failed.fallbackTriedKeys = triedKeys;
      failed.fallbackCandidates = [];
      failed.fallbackPlanResolved = planResolved;
      this.logger.warn?.("No strict playable mirror remained", {
        guildId: this.guildId,
        requestedTitle: failed.title,
        requestedArtist: failed.author,
        attempts: Number(failed.fallbackAttemptCount || 0),
        searchAttempts: fallbackResult?.attempts,
        rejectedCandidates: fallbackResult?.rejections?.slice(0, 10),
      });
      this._scheduleExceptionStop(failedEncoded);
      this._notify("exception");
      return this.current;
    });
  }

  async _handleTrackEnd(event = {}) {
    this._clearPlaybackStartWatchdog(event?.track?.encoded || null);
    return super._handleTrackEnd(event);
  }

  async skip() {
    this._clearPlaybackStartWatchdog(this.current?.encoded || null);
    return super.skip();
  }

  async stopAndClear() {
    this._clearPlaybackStartWatchdog();
    return super.stopAndClear();
  }

  async disconnect() {
    this._clearPlaybackStartWatchdog();
    return super.disconnect();
  }
}

module.exports = {
  DEFAULT_PLAYBACK_START_TIMEOUT_MS,
  MAX_RUNTIME_FALLBACK_ATTEMPTS,
  PLAYBACK_ENGINE_BUILD,
  ResilientGuildPlayer,
  uniqueKeys,
};
