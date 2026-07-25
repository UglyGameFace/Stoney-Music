"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, "..", "data", "guild-config.json");

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function configuredValue(value, defaults, key) {
  if (Object.prototype.hasOwnProperty.call(value, key)) return cleanString(value[key]);
  return cleanString(defaults[key]);
}

function normalizeGuildConfig(value = {}, defaults = {}) {
  return {
    musicTextChannelId: configuredValue(value, defaults, "musicTextChannelId"),
    roleVerifiedId: configuredValue(value, defaults, "roleVerifiedId"),
    roleVerified: configuredValue(value, defaults, "roleVerified"),
    roleResidentId: configuredValue(value, defaults, "roleResidentId"),
    roleResident: configuredValue(value, defaults, "roleResident"),
    setupPanelChannelId: configuredValue(value, defaults, "setupPanelChannelId"),
    setupPanelMessageId: configuredValue(value, defaults, "setupPanelMessageId"),
  };
}

class GuildConfigStore {
  constructor({ filePath = process.env.MUSIC_CONFIG_PATH || DEFAULT_CONFIG_PATH, defaults = {} } = {}) {
    this.filePath = path.resolve(filePath);
    this.defaults = normalizeGuildConfig(defaults);
    this.guilds = {};
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return this;

    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.guilds && typeof parsed.guilds === "object") {
        for (const [guildId, value] of Object.entries(parsed.guilds)) {
          this.guilds[guildId] = normalizeGuildConfig(value, this.defaults);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Could not read saved music configuration: ${error.message}`);
      }
    }

    this.loaded = true;
    return this;
  }

  get(guildId) {
    const saved = guildId ? this.guilds[String(guildId)] : null;
    return normalizeGuildConfig(saved || {}, this.defaults);
  }

  hasSavedSetup(guildId) {
    if (!guildId) return false;
    return Boolean(this.guilds[String(guildId)]?.musicTextChannelId);
  }

  async set(guildId, patch) {
    if (!guildId) throw new TypeError("A guild ID is required to save music configuration.");
    if (!this.loaded) await this.load();

    const key = String(guildId);
    const current = this.get(key);
    this.guilds[key] = normalizeGuildConfig({ ...current, ...patch }, this.defaults);
    await this._write();
    return this.get(key);
  }

  async _write() {
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp`;
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(
      temporary,
      `${JSON.stringify({ version: 1, guilds: this.guilds }, null, 2)}\n`,
      { mode: 0o600 }
    );
    await fsp.rename(temporary, this.filePath);
  }
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  GuildConfigStore,
  cleanString,
  configuredValue,
  normalizeGuildConfig,
};
