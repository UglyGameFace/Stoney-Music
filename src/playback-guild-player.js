"use strict";

const { ResilientGuildPlayer } = require("./resilient-guild-player");

const MIN_STABLE_PLAYBACK_POSITION_MS = 1_000;
const PLAYBACK_ENGINE_BUILD = "resilient-v5-stable-mirror-routing";

class PlaybackGuildPlayer extends ResilientGuildPlayer {
  constructor(...args) {
    super(...args);
    this._fallbackVerificationState = null;
  }

  _clearFallbackVerification(encoded = null) {
    const state = this._fallbackVerificationState;
    if (!state) return false;
    if (encoded && state.encoded && encoded !== state.encoded) return false;
    this._fallbackVerificationState = null;
    return true;
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

  _bindFallbackVerification(bound) {
    if (!bound || this._fallbackBoundPlayer === bound) return;
    this._fallbackBoundPlayer = bound;

    bound.on("start", (event = {}) => {
      if (this.player !== bound || !this.current) return;
      const startedEncoded = event?.track?.encoded;
      if (startedEncoded && startedEncoded !== this.current.encoded) return;

      this._clearPlaybackStartWatchdog(this.current.encoded);
      if (!this.current.fallbackPending) return;

      this._fallbackVerificationState = {
        encoded: this.current.encoded,
        startedAt: Date.now(),
      };
      this.logger.log?.("▶️ Playback mirror opened; awaiting stable audio", {
        guildId: this.guildId,
        requestedTitle: this.current.title,
        playbackTitle: this.current.playbackCandidateTitle,
        source: this.current.sourceName,
      });
    });

    bound.on("update", (event = {}) => {
      const current = this.current;
      const state = this._fallbackVerificationState;
      if (!current || !state || this.player !== bound || state.encoded !== current.encoded) return;

      const positionMs = Math.max(
        Number(event?.position || 0),
        Number(event?.state?.position || 0),
        Number(bound.position || 0)
      );
      this._confirmFallbackPlayback(bound, current, positionMs).catch((error) => {
        this.logger.warn?.("Could not verify stable playback mirror", {
          guildId: this.guildId,
          message: error?.message || String(error),
        });
      });
    });
  }

  async _startTrack(track) {
    this._clearFallbackVerification();
    return super._startTrack(track);
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
    }

    return super._handleTrackException(event);
  }

  async _handleTrackEnd(event = {}) {
    const reason = String(event?.reason || "finished");
    const endedEncoded = event?.track?.encoded || null;
    const active = this.current;

    if (
      reason === "loadFailed" &&
      active &&
      (!endedEncoded || endedEncoded === active.encoded)
    ) {
      this.logger.warn?.(
        "📥 Lavalink reported loadFailed; routing directly into mirror recovery",
        {
          guildId: this.guildId,
          requestedTitle: active.title,
          requestedArtist: active.author,
          playbackTitle: active.playbackCandidateTitle || active.title,
          playbackArtist: active.playbackCandidateAuthor || active.author,
          source: active.sourceName,
        }
      );

      return this._handleTrackException({
        ...event,
        track: { encoded: endedEncoded || active.encoded },
        exception:
          event?.exception ||
          {
            message:
              "Lavalink ended the track with reason loadFailed before stable audio playback was confirmed.",
          },
        loadFailedEnd: true,
      });
    }

    this._clearFallbackVerification(endedEncoded || active?.encoded || null);
    return super._handleTrackEnd(event);
  }

  async skip() {
    this._clearFallbackVerification(this.current?.encoded || null);
    return super.skip();
  }

  async stopAndClear() {
    this._clearFallbackVerification();
    return super.stopAndClear();
  }

  async disconnect() {
    this._clearFallbackVerification();
    return super.disconnect();
  }
}

module.exports = {
  MIN_STABLE_PLAYBACK_POSITION_MS,
  PLAYBACK_ENGINE_BUILD,
  PlaybackGuildPlayer,
};
