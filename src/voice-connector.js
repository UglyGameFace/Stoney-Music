"use strict";

const { Connectors } = require("shoukaku");

const VOICE_STATE_UPDATE = "VOICE_STATE_UPDATE";
const VOICE_SERVER_UPDATE = "VOICE_SERVER_UPDATE";

class StableDiscordJSConnector extends Connectors.DiscordJS {
  constructor(client, { logger = console } = {}) {
    super(client);
    this.logger = logger;
    this.pendingServerUpdates = new Map();
    this._readyStarted = false;
  }

  listen(nodes) {
    const start = () => {
      if (this._readyStarted) return;
      this._readyStarted = true;
      this.ready(nodes);
      this.logger.log?.(
        `🎚️ Shoukaku connector initialized for Discord user ${this.manager?.id || "unknown"}.`
      );
    };

    this.client.on("raw", (packet) => this.raw(packet));

    // PlayerManager is intentionally created inside Discord's ClientReady handler.
    // The stock Shoukaku Discord.js connector waits for a future clientReady event,
    // which will never arrive in that lifecycle. Start immediately when Discord is
    // already ready, otherwise preserve the normal event-driven startup path.
    if (this.client.isReady?.()) start();
    else this.client.once("clientReady", start);
  }

  raw(packet) {
    if (!packet || ![VOICE_STATE_UPDATE, VOICE_SERVER_UPDATE].includes(packet.t)) return;

    const guildId = packet.d?.guild_id;
    if (!guildId) return;

    const manager = this.manager;
    const connection = manager?.connections?.get(guildId);
    if (!connection) return;

    if (packet.t === VOICE_SERVER_UPDATE) {
      if (!packet.d?.endpoint) {
        connection.setServerUpdate(packet.d);
        return;
      }

      if (!connection.sessionId) {
        this.pendingServerUpdates.set(guildId, packet.d);
        this.logger.warn?.(
          `🔄 Discord voice server data arrived before the session ID for guild ${guildId}; ` +
            "buffering it until the matching voice-state update arrives."
        );
        return;
      }

      this.pendingServerUpdates.delete(guildId);
      connection.setServerUpdate(packet.d);
      return;
    }

    if (packet.d?.user_id !== manager?.id) return;

    connection.setStateUpdate(packet.d);

    if (!packet.d?.channel_id) {
      this.pendingServerUpdates.delete(guildId);
      return;
    }

    const pending = this.pendingServerUpdates.get(guildId);
    if (!pending || !connection.sessionId) return;

    this.pendingServerUpdates.delete(guildId);
    connection.setServerUpdate(pending);
    this.logger.log?.(`✅ Completed buffered Discord voice handshake for guild ${guildId}.`);
  }
}

module.exports = {
  StableDiscordJSConnector,
  VOICE_SERVER_UPDATE,
  VOICE_STATE_UPDATE,
};
