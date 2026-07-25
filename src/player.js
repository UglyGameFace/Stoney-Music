"use strict";

const { Shoukaku } = require("shoukaku");
const { resolveAutoplayRecommendation } = require("./autoplay");
const { refineInitialResolution } = require("./initial-track-selector");
const { PlaybackMatchCache } = require("./playback-cache");
const {
  fallbackIdentityKey,
  playbackCandidateKey,
  resolvePlaybackFallback,
} = require("./playback-fallback");
const {
  DEFAULT_PLAYBACK_START_TIMEOUT_MS,
} = require("./resilient-guild-player");
const {
  PLAYBACK_ENGINE_BUILD,
  PlaybackGuildPlayer,
} = require("./playback-guild-player");
const { MusicResolutionError, resolveMusicQuery } = require("./resolver");
const { StableDiscordJSConnector } = require("./voice-connector");

const PRODUCTION_FALLBACK_PREFIXES = Object.freeze(["scsearch", "ytmsearch", "ytsearch"]);
const FAST_VERSION_PATTERN = /\b(?:fast|faster|sped\s*up|speed\s*up|accelerated)\b/i;

function trackIdentity(track = {}) {
  return track.playbackIdentity || track.stoneyIdentity || {};
}

function requestAllowsFastVersion(query, track = {}) {
  const identity = trackIdentity(track);
  return FAST_VERSION_PATTERN.test(
    [query, identity.title, identity.requestedQuery]
      .filter(Boolean)
      .join(" ")
  );
}

function candidateIsFastVersion(track = {}) {
  return FAST_VERSION_PATTERN.test(
    String(track.playbackCandidateTitle || track.title || "")
  );
}

function filterUnrequestedFastResolution(resolution, query) {
  if (
    !resolution ||
    resolution.source === "direct" ||
    !Array.isArray(resolution.tracks) ||
    !resolution.tracks.length
  ) {
    return resolution;
  }

  const kept = [];
  const rejected = [];
  for (const track of resolution.tracks) {
    if (requestAllowsFastVersion(query, track) || !candidateIsFastVersion(track)) {
      kept.push(track);
    } else {
      rejected.push(track);
    }
  }

  if (!rejected.length) return resolution;
  if (!kept.length) {
    throw new MusicResolutionError("Only unrequested fast versions were found.", {
      code: "FAST_VERSION_ONLY",
      userMessage:
        "The original version was not available. Stoney refused to substitute a fast or sped-up version because you did not request one.",
      attempts: resolution.attempts || [],
    });
  }

  return {
    ...resolution,
    tracks: kept,
    notices: [
      ...(resolution.notices || []),
      `Rejected ${rejected.length} unrequested fast/sped-up version(s).`,
    ],
  };
}

function filterUnrequestedFastFallback(originalTrack, result) {
  if (!result || !Array.isArray(result.candidates) || !result.candidates.length) return result;
  if (requestAllowsFastVersion(originalTrack?.requestedQuery, originalTrack)) return result;

  const rejectedFast = result.candidates.filter(candidateIsFastVersion);
  if (!rejectedFast.length) return result;

  const candidates = result.candidates.filter((track) => !candidateIsFastVersion(track));
  const first = candidates[0] || null;
  return {
    ...result,
    track: first,
    candidates,
    source: first?.fallbackSource || null,
    score: Number(first?.fallbackScore || 0),
    rejections: [
      ...(result.rejections || []),
      ...rejectedFast.map((track) => ({
        source: track.fallbackSource || track.sourceName || "unknown",
        title: track.playbackCandidateTitle || track.title || "Unknown title",
        author: track.playbackCandidateAuthor || track.author || "Unknown artist",
        score: Number(track.fallbackScore || 0),
        reasons: ["alternate-version:fast"],
      })),
    ],
  };
}

function candidateLevelRetryTrack(track = {}) {
  return {
    ...track,
    playbackIdentity: track.playbackIdentity ? { ...track.playbackIdentity } : track.playbackIdentity,
    fallbackFrom: track.fallbackFrom || track.sourceName || "unknown",
    // resolvePlaybackFallback historically skipped the entire failed provider.
    // Mark the failed item as a candidate so tried/dead keys—not the provider—control retries.
    sourceName: "failed-candidate",
  };
}

class PlayerManager {
  constructor({ nodes, discordClient, logger = console }) {
    const connector = new StableDiscordJSConnector(discordClient, { logger });
    this.logger = logger;
    this.playbackCache = new PlaybackMatchCache({ logger });
    this.playbackCacheReady = this.playbackCache.load();
    const configuredStartTimeout = Number(process.env.PLAYBACK_START_TIMEOUT_MS);
    this.playbackStartTimeoutMs = Number.isFinite(configuredStartTimeout) && configuredStartTimeout >= 1_000
      ? Math.round(configuredStartTimeout)
      : DEFAULT_PLAYBACK_START_TIMEOUT_MS;

    this.logger.log?.(
      `🧬 Playback engine loaded: ${PLAYBACK_ENGINE_BUILD} ` +
        `(start watchdog ${this.playbackStartTimeoutMs}ms, stable mirror verification, ` +
        `loadFailed routing and sequential provider retries enabled)`
    );

    this.shoukaku = new Shoukaku(connector, nodes, {
      reconnectTries: 5,
      reconnectInterval: 5_000,
      resume: true,
      resumeTimeout: 30,
      voiceConnectionTimeout: 20,
    });

    this.shoukaku.on("ready", (name, resumed) =>
      this.logger.log?.(`🎧 Lavalink READY: ${name}${resumed ? " (resumed)" : ""}`)
    );
    this.shoukaku.on("error", (name, error) =>
      this.logger.error?.(`❌ Lavalink ERROR: ${name}`, error)
    );
    this.shoukaku.on("close", (name, code, reason) =>
      this.logger.warn?.(`🔌 Lavalink CLOSE: ${name} code=${code} reason=${reason}`)
    );
    this.shoukaku.on("disconnect", (name, count) =>
      this.logger.warn?.(`🔌 Lavalink DISCONNECT: ${name} affectedPlayers=${count}`)
    );

    this.guildPlayers = new Map();
  }

  get(guildId) {
    const key = String(guildId);
    if (!this.guildPlayers.has(key)) {
      this.guildPlayers.set(
        key,
        new PlaybackGuildPlayer(this.shoukaku, key, {
          logger: this.logger,
          resolveFallback: (track, options) => this.resolveFallback(track, options),
          resolveAutoplay: (seed, context) => this.resolveAutoplay(seed, context),
          onFallbackVerified: (track) => this.rememberVerifiedFallback(track),
          onFallbackFailed: (track, reason) => this.rememberFailedFallback(track, reason),
          playbackStartTimeoutMs: this.playbackStartTimeoutMs,
        })
      );
    }
    return this.guildPlayers.get(key);
  }

  peek(guildId) {
    return this.guildPlayers.get(String(guildId)) || null;
  }

  _node() {
    return this.shoukaku.getIdealNode();
  }

  async resolve(identifier) {
    const node = this._node();
    if (!node) throw new Error("No Lavalink node is ready.");
    return node.rest.resolve(identifier);
  }

  async resolveFallback(track, options = {}) {
    await this.playbackCacheReady;
    const identityKey = fallbackIdentityKey(track);
    const cached = this.playbackCache.get(identityKey, { requesterId: track.requesterId });
    const result = await resolvePlaybackFallback(candidateLevelRetryTrack(track), {
      ...options,
      prefixes: options.prefixes || PRODUCTION_FALLBACK_PREFIXES,
      cachedCandidates: cached ? [cached] : [],
      deadKeys: this.playbackCache.deadKeys(),
      resolve: (identifier) => this.resolve(identifier),
    });
    return filterUnrequestedFastFallback(track, result);
  }

  async rememberVerifiedFallback(track) {
    await this.playbackCacheReady;
    const identityKey = fallbackIdentityKey(track);
    const candidateKey = playbackCandidateKey(track);
    await this.playbackCache.rememberGood(identityKey, candidateKey, track);
  }

  async rememberFailedFallback(track, reason) {
    await this.playbackCacheReady;
    const identityKey = fallbackIdentityKey(track);
    const candidateKey = playbackCandidateKey(track);
    await this.playbackCache.rememberDead(identityKey, candidateKey, reason);
  }

  async resolveAutoplay(seed, options = {}) {
    return resolveAutoplayRecommendation(seed, {
      ...options,
      logger: this.logger,
      resolve: (identifier) => this.resolve(identifier),
    });
  }

  async resolveQuery(query, options = {}) {
    const resolution = await resolveMusicQuery(query, {
      ...options,
      resolve: (identifier) => this.resolve(identifier),
    });
    const refined = await refineInitialResolution(resolution, query, {
      resolve: (identifier) => this.resolve(identifier),
    });
    return filterUnrequestedFastResolution(refined, query);
  }
}

module.exports = {
  FAST_VERSION_PATTERN,
  GuildPlayer: PlaybackGuildPlayer,
  PlayerManager,
  PlaybackGuildPlayer,
  PRODUCTION_FALLBACK_PREFIXES,
  ResilientGuildPlayer: PlaybackGuildPlayer,
  candidateIsFastVersion,
  candidateLevelRetryTrack,
  filterUnrequestedFastFallback,
  filterUnrequestedFastResolution,
  requestAllowsFastVersion,
};
