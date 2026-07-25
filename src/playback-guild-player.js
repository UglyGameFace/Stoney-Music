"use strict";

const { ResilientGuildPlayer } = require("./resilient-guild-player");

const PLAYBACK_ENGINE_BUILD = "resilient-v4-loadfailed-routing";

class PlaybackGuildPlayer extends ResilientGuildPlayer {
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
              "Lavalink ended the track with reason loadFailed before audio playback was confirmed.",
          },
        loadFailedEnd: true,
      });
    }

    return super._handleTrackEnd(event);
  }
}

module.exports = {
  PLAYBACK_ENGINE_BUILD,
  PlaybackGuildPlayer,
};
