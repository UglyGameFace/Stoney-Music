"use strict";

const { ResilientGuildPlayer } = require("./resilient-guild-player");

const MIN_STABLE_PLAYBACK_POSITION_MS = 1_000;
const PLAYBACK_ENGINE_BUILD = "resilient-v6-source-stability-watchdog";
const PREMATURE_END_REASONS = new Set(["finished", "cleanup"]);

class PlaybackGuildPlayer extends ResilientGuildPlayer {
  constructor(...args) {
    super(...args);
    this._fallbackVerificationState = null;
    this._playbackStatus = null;
  }

  snapshot() {
    return {
      ...super.snapshot(),
      playbackStatus: this._playbackStatus ? { ...this._playbackStatus } : null,
    };
  }

  _setPlaybackStatus(phase, message, track = this.current) {
    this._playbackStatus = {
      phase: String(phase || "unknown"),
      message: String(message || "").slice(0, 1_000),
      title: String(track?.title || ""),
      artist: String(track?.author || ""),
      source: String(track?.sourceName || "unknown"),
      updatedAt: Date.now(),
    };
  }

  _clearPlaybackStatus() {
    this._playbackStatus = null;
  }

  _clearFallbackVerification(encoded = null) {
    const state = this._fallbackVerificationState;
    if (!state) return false;
    if (encoded && state.encoded && encoded !== state.encoded) return false;
    this._fallbackVerificationState = null;
    return true;
  }

  _isStablePlaybackAttempt(track = this.current) {
    if (!track) return false;
    const attemptRevision = Number(track._playbackAttemptRevision || 0);
    return (
      attemptRevision > 0 &&
      attemptRevision === Number(this._playbackStartRevision || 0) &&
      Number(track._stablePlaybackRevision || 0) === attemptRevision
    );
  }

  async _confirmFallbackPlayback(bound, track, positionMs) {
    const state = this._fallbackVerificationState;
    if (
      !state ||
      this.player !== bound ||
      this.current !== track ||
      state.encoded !== track?.encoded ||
      !track.fallbackPending ||
      Number(positionMs || 0) < MIN_STABLE_PLAYBACK_POSITION_MS
    ) {
      return false;
    }

    this._fallbackVerificationState = null;
    track.fallbackPending = false;
    track.fallbackVerified = true;
    this._clearPlaybackStatus();
    this.logger.log?.("✅ Playback mirror confirmed after stable audio", {
      guildId: this.guildId,
      requestedTitle: track.title,
      requestedArtist: track.author,
      playbackTitle: track.playbackCandidateTitle,
      playbackArtist: track.playbackCandidateAuthor,
      source: track.sourceName,
      positionMs: Math.round(Number(positionMs || 0)),
      score: Number(track.fallbackScore || 0).toFixed(3),
    });

    try {
      await this.onFallbackVerified?.(track);
    } catch (error) {
      this.logger.warn?.("Could not remember a proven playback mirror", {
        guildId: this.guildId,
        message: error?.message || String(error),
      });
    }
    this._notify("fallbackVerified");
    return true;
  }

  async _markStablePlayback(bound, track, positionMs) {
    const revision = Number(this._playbackStartRevision || 0);
    if (
      !track ||
      this.player !== bound ||
      this.current !== track ||
      Number(track._playbackAttemptRevision || 0) !== revision ||
      Number(positionMs || 0) < MIN_STABLE_PLAYBACK_POSITION_MS
    ) {
      return false;
    }

    const firstStableUpdate = Number(track._stablePlaybackRevision || 0) !== revision;
    track._stablePlaybackRevision = revision;
    this._clearPlaybackStartWatchdog(track.encoded);

    if (track.fallbackPending) {
      return this._confirmFallbackPlayback(bound, track, positionMs);
    }

    if (firstStableUpdate) {
      this._clearPlaybackStatus();
      this.logger.log?.("▶️ Playback confirmed after audio position advanced", {
        guildId: this.guildId,
        title: track.title,
        artist: track.author,
        source: track.sourceName,
        positionMs: Math.round(Number(positionMs || 0)),
      });
      this._notify("playbackStable");
    }
    return true;
  }

  _bindFallbackVerification(bound) {
    if (!bound || this._fallbackBoundPlayer === bound) return;
    this._fallbackBoundPlayer = bound;

    bound.on("start", (event = {}) => {
      if (this.player !== bound || !this.current) return;
      const startedEncoded = event?.track?.encoded;
      if (startedEncoded && startedEncoded !== this.current.encoded) return;

      // Lavalink may emit start before the provider has yielded a single audio frame.
      // Keep the start watchdog armed until a player update proves position progress.
      this._setPlaybackStatus(
        "opening",
        this.current.fallbackPending
          ? "An exact mirror opened. Waiting for audible playback before confirming it."
          : "The source opened. Waiting for audible playback before marking it healthy.",
        this.current
      );

      if (this.current.fallbackPending) {
        this._fallbackVerificationState = {
          encoded: this.current.encoded,
          revision: Number(this._playbackStartRevision || 0),
          startedAt: Date.now(),
        };
        this.logger.log?.("▶️ Playback mirror opened; awaiting stable audio", {
          guildId: this.guildId,
          requestedTitle: this.current.title,
          playbackTitle: this.current.playbackCandidateTitle,
          source: this.current.sourceName,
        });
      }
      this._notify("sourceOpened");
    });

    bound.on("update", (event = {}) => {
      const current = this.current;
      if (!current || this.player !== bound) return;

      const positionMs = Math.max(
        Number(event?.position || 0),
        Number(event?.state?.position || 0),
        Number(bound.position || 0)
      );
      this._markStablePlayback(bound, current, positionMs).catch((error) => {
        this.logger.warn?.("Could not verify stable playback", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    });
  }

  async _startTrack(track) {
    this._clearFallbackVerification();
    const expectedRevision = Number(this._playbackStartRevision || 0) + 1;
    track._playbackAttemptRevision = expectedRevision;
    track._stablePlaybackRevision = 0;
    track._failureRecoveryClaimedRevision = 0;
    this._setPlaybackStatus(
      track.isFallback ? "recovering" : "starting",
      track.isFallback
        ? "Trying an exact alternate source."
        : "Opening the requested track source.",
      track
    );

    try {
      return await super._startTrack(track);
    } catch (error) {
      this._setPlaybackStatus(
        "failed",
        `The source could not be opened: ${error?.message || String(error)}`,
        track
      );
      throw error;
    }
  }

  async _markFallbackFailed(track, reason) {
    this._clearFallbackVerification(track?.encoded || null);
    return super._markFallbackFailed(track, reason);
  }

  async _handleTrackException(event = {}) {
    const active = this.current;
    const failedEncoded = event?.track?.encoded || active?.encoded || null;

    if (active && (!failedEncoded || failedEncoded === active.encoded)) {
      const revision = Number(this._playbackStartRevision || 0);
      if (active._failureRecoveryClaimedRevision === revision) {
        this.logger.warn?.("Ignoring duplicate playback failure event", {
          guildId: this.guildId,
          playbackTitle: active.playbackCandidateTitle || active.title,
          source: active.sourceName,
          encoded: active.encoded,
        });
        return active;
      }
      active._failureRecoveryClaimedRevision = revision;
      this._clearFallbackVerification(active.encoded);
      this._setPlaybackStatus(
        "recovering",
        "The current source failed before stable audio. Searching for an exact playable mirror.",
        active
      );
      this._notify("recovering");
    }

    const failed = active;
    const result = await super._handleTrackException(event);

    if (failed && this.current === failed) {
      this._setPlaybackStatus(
        "failed",
        "No exact playable source remained. YouTube is blocked on this host and the available alternate results could not provide working audio.",
        failed
      );
      this._notify("playbackFailed");
    }
    return result;
  }

  async _handleTrackEnd(event = {}) {
    const reason = String(event?.reason || "finished");
    const endedEncoded = event?.track?.encoded || null;
    const active = this.current;
    const isCurrent = Boolean(active && (!endedEncoded || endedEncoded === active.encoded));
    const stable = isCurrent && this._isStablePlaybackAttempt(active);
    const longEnoughToRequireProgress = Number(active?.durationMs || 0) > MIN_STABLE_PLAYBACK_POSITION_MS * 2;
    const prematureEnd =
      isCurrent &&
      !stable &&
      (reason === "loadFailed" || (PREMATURE_END_REASONS.has(reason) && longEnoughToRequireProgress));

    if (reason === "loadFailed" || prematureEnd) {
      this.logger.warn?.("📥 Lavalink ended before stable audio; routing into mirror recovery", {
        guildId: this.guildId,
        reason,
        requestedTitle: active?.title,
        requestedArtist: active?.author,
        playbackTitle: active?.playbackCandidateTitle || active?.title,
        playbackArtist: active?.playbackCandidateAuthor || active?.author,
        source: active?.sourceName,
        stable,
      });

      return this._handleTrackException({
        ...event,
        track: { encoded: endedEncoded || active?.encoded },
        exception:
          event?.exception ||
          {
            message: `Lavalink ended the track with reason ${reason} before stable audio playback was confirmed.`,
          },
        prematureEnd: true,
      });
    }

    this._clearFallbackVerification(endedEncoded || active?.encoded || null);
    if (isCurrent && reason === "finished") this._clearPlaybackStatus();
    return super._handleTrackEnd(event);
  }

  async skip() {
    this._clearFallbackVerification(this.current?.encoded || null);
    this._clearPlaybackStatus();
    return super.skip();
  }

  async stopAndClear() {
    this._clearFallbackVerification();
    this._clearPlaybackStatus();
    return super.stopAndClear();
  }

  async disconnect() {
    this._clearFallbackVerification();
    this._clearPlaybackStatus();
    return super.disconnect();
  }
}

module.exports = {
  MIN_STABLE_PLAYBACK_POSITION_MS,
  PLAYBACK_ENGINE_BUILD,
  PlaybackGuildPlayer,
};
