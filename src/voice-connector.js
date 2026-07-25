"use strict";

const { Connectors } = require("shoukaku");

const VOICE_STATE_UPDATE = "VOICE_STATE_UPDATE";
const VOICE_SERVER_UPDATE = "VOICE_SERVER_UPDATE";

class StableDiscordJSConnector extends Connectors.DiscordJS {
  constructor(client, { logger = console } = {}) {
    super(client);
    this.logger = logger;
    this.pendingServerUpdates = new Map();
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
