"use strict";

const { Shoukaku, Connectors } = require("shoukaku");
const { GuildPlayer } = require("./guild-player");
const { resolveMusicQuery } = require("./resolver");

class PlayerManager {
  constructor({ nodes, discordClient, logger = console }) {
    const connector = new Connectors.DiscordJS(discordClient);
    this.logger = logger;

    this.shoukaku = new Shoukaku(connector, nodes, {
      reconnectTries: 5,
      reconnectInterval: 5_000,
      resume: true,
      resumeTimeout: 30,
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
      this.guildPlayers.set(guildId, new GuildPlayer(this.shoukaku, guildId, { logger: this.logger }));
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

  async resolveQuery(query, options = {}) {
    return resolveMusicQuery(query, {
      ...options,
      resolve: (identifier) => this.resolve(identifier),
    });
  }
}

module.exports = { GuildPlayer, PlayerManager };
