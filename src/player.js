"use strict";

const { Shoukaku } = require("shoukaku");
const { resolveAutoplayRecommendation } = require("./autoplay");
const { PlaybackMatchCache } = require("./playback-cache");
const {
  fallbackIdentityKey,
  playbackCandidateKey,
  resolvePlaybackFallback,
} = require("./playback-fallback");
const { ResilientGuildPlayer } = require("./resilient-guild-player");
const { resolveMusicQuery } = require("./resolver");
const { StableDiscordJSConnector } = require("./voice-connector");

class PlayerManager {
  constructor({ nodes, discordClient, logger = console }) {
    const connector = new StableDiscordJSConnector(discordClient, { logger });
    this.logger = logger;
    this.playbackCache = new PlaybackMatchCache({ logger });
    this.playbackCacheReady = this.playbackCache.load();

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
        new ResilientGuildPlayer(this.shoukaku, key, {
          logger: this.logger,
          resolveFallback: (track, options) => this.resolveFallback(track, options),
          resolveAutoplay: (seed, context) => this.resolveAutoplay(seed, context),
          onFallbackVerified: (track) => this.rememberVerifiedFallback(track),
          onFallbackFailed: (track, reason) => this.rememberFailedFallback(track, reason),
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
    return resolvePlaybackFallback(track, {
      ...options,
      cachedCandidates: cached ? [cached] : [],
      deadKeys: this.playbackCache.deadKeys(),
      resolve: (identifier) => this.resolve(identifier),
    });
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
    return resolveMusicQuery(query, {
      ...options,
      resolve: (identifier) => this.resolve(identifier),
    });
  }
}

module.exports = { GuildPlayer: ResilientGuildPlayer, PlayerManager, ResilientGuildPlayer };
