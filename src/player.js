"use strict";

const { Shoukaku } = require("shoukaku");
const { resolveAutoplayRecommendation } = require("./autoplay");
const { GuildPlayer } = require("./guild-player");
const { resolvePlaybackFallback } = require("./playback-fallback");
const { resolveMusicQuery } = require("./resolver");
const { StableDiscordJSConnector } = require("./voice-connector");

class PlayerManager {
  constructor({ nodes, discordClient, logger = console }) {
    const connector = new StableDiscordJSConnector(discordClient, { logger });
    this.logger = logger;

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
    if (!this.guildPlayers.has(guildId)) {
      this.guildPlayers.set(
        guildId,
        new GuildPlayer(this.shoukaku, guildId, {
          logger: this.logger,
          resolveFallback: (track) => this.resolveFallback(track),
          resolveAutoplay: (seed, context) => this.resolveAutoplay(seed, context),
        })
      );
    }
    return this.guildPlayers.get(guildId);
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
    return resolvePlaybackFallback(track, {
      ...options,
      resolve: (identifier) => this.resolve(identifier),
    });
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

module.exports = { GuildPlayer, PlayerManager };
