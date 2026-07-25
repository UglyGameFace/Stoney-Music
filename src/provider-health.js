"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_PROVIDER_HEALTH_PATH = path.resolve(__dirname, "..", "data", "provider-health.json");
const DEFAULT_YOUTUBE_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

function normalizeNodeKey(nodes = []) {
  const node = Array.isArray(nodes) ? nodes[0] || {} : nodes || {};
  return [node.name || "main", node.url || "unknown", node.secure ? "secure" : "plain"]
    .map((value) => String(value || ""))
    .join("|")
    .slice(0, 500);
}

function providerForSearchIdentifier(identifier) {
  const value = String(identifier || "").trim().toLowerCase();
  if (/^(?:ytsearch|ytmsearch):/.test(value)) return "youtube";
  if (/^scsearch:/.test(value)) return "soundcloud";
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be") {
      return "youtube";
    }
    if (host === "soundcloud.com" || host === "on.soundcloud.com") return "soundcloud";
  } catch {
    // Not a URL; search prefixes above are the only relevant provider identifiers.
  }
  return null;
}

function failureText(event = {}, shortMessage = "") {
  return [
    shortMessage,
    event?.message,
    event?.exception?.message,
    event?.exception?.cause,
    event?.exception?.stack,
  ]
    .filter(Boolean)
    .map(String)
    .join("\n");
}

function isYoutubeHostWideBlock(track = {}, event = {}, shortMessage = "") {
  const source = String(track.sourceName || track.playbackIdentity?.sourceType || "").toLowerCase();
  if (!source.includes("youtube")) return false;

  const text = failureText(event, shortMessage);
  const allClientsFailed = /all clients failed/i.test(text);
  const botChallenge = /sign in to confirm[^\n]*not a bot|confirm you.?re not a bot/i.test(text);
  const loginChallenge = /this video requires login/i.test(text);
  const playerConfigurationFailure = /video player configuration error/i.test(text);

  return allClientsFailed && (botChallenge || (loginChallenge && playerConfigurationFailure));
}

class ProviderHealthStore {
  constructor({
    filePath = process.env.PROVIDER_HEALTH_PATH || DEFAULT_PROVIDER_HEALTH_PATH,
    nodeKey = "main|unknown|plain",
    youtubeCooldownMs = Number(process.env.YOUTUBE_CIRCUIT_COOLDOWN_MS) || DEFAULT_YOUTUBE_COOLDOWN_MS,
    logger = console,
  } = {}) {
    this.filePath = path.resolve(filePath);
    this.nodeKey = String(nodeKey || "main|unknown|plain");
    this.youtubeCooldownMs = Math.max(60_000, Number(youtubeCooldownMs) || DEFAULT_YOUTUBE_COOLDOWN_MS);
    this.logger = logger;
    this.nodes = {};
    this.loaded = false;
    this._writePromise = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      this.nodes = parsed?.nodes && typeof parsed.nodes === "object" ? parsed.nodes : {};
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn?.("Could not read provider health cache", {
          path: this.filePath,
          message: error?.message || String(error),
        });
      }
    }
    this.loaded = true;
    this.prune();
    return this;
  }

  _nodeState() {
    if (!this.nodes[this.nodeKey] || typeof this.nodes[this.nodeKey] !== "object") {
      this.nodes[this.nodeKey] = {};
    }
    return this.nodes[this.nodeKey];
  }

  prune(now = Date.now()) {
    for (const [nodeKey, providers] of Object.entries(this.nodes)) {
      if (!providers || typeof providers !== "object") {
        delete this.nodes[nodeKey];
        continue;
      }
      for (const [provider, entry] of Object.entries(providers)) {
        if (!entry || Number(entry.blockedUntil || 0) <= now) delete providers[provider];
      }
      if (!Object.keys(providers).length) delete this.nodes[nodeKey];
    }
  }

  blockedUntil(provider, now = Date.now()) {
    this.prune(now);
    return Number(this.nodes[this.nodeKey]?.[String(provider || "")]?.blockedUntil || 0);
  }

  isBlocked(provider, now = Date.now()) {
    return this.blockedUntil(provider, now) > now;
  }

  remainingMs(provider, now = Date.now()) {
    return Math.max(0, this.blockedUntil(provider, now) - now);
  }

  reason(provider) {
    return String(this.nodes[this.nodeKey]?.[String(provider || "")]?.reason || "");
  }

  async block(provider, reason, { now = Date.now(), cooldownMs = null } = {}) {
    const name = String(provider || "").trim();
    if (!name) return 0;
    const duration = Math.max(60_000, Number(cooldownMs) || this.youtubeCooldownMs);
    const providers = this._nodeState();
    const previous = providers[name] || {};
    providers[name] = {
      blockedUntil: now + duration,
      updatedAt: now,
      failures: Number(previous.failures || 0) + 1,
      reason: String(reason || "provider-unhealthy").slice(0, 500),
    };
    await this._write();
    return providers[name].blockedUntil;
  }

  async clear(provider) {
    const providers = this.nodes[this.nodeKey];
    if (!providers) return false;
    const existed = Boolean(providers[String(provider || "")]);
    delete providers[String(provider || "")];
    if (!Object.keys(providers).length) delete this.nodes[this.nodeKey];
    if (existed) await this._write();
    return existed;
  }

  async _write() {
    this._writePromise = this._writePromise
      .catch(() => {})
      .then(async () => {
        const directory = path.dirname(this.filePath);
        const temporary = `${this.filePath}.tmp`;
        await fsp.mkdir(directory, { recursive: true });
        await fsp.writeFile(
          temporary,
          `${JSON.stringify({ version: 1, nodes: this.nodes }, null, 2)}\n`,
          { mode: 0o600 }
        );
        await fsp.rename(temporary, this.filePath);
      })
      .catch((error) => {
        this.logger.warn?.("Could not write provider health cache", {
          path: this.filePath,
          message: error?.message || String(error),
        });
      });
    return this._writePromise;
  }
}

module.exports = {
  DEFAULT_PROVIDER_HEALTH_PATH,
  DEFAULT_YOUTUBE_COOLDOWN_MS,
  ProviderHealthStore,
  failureText,
  isYoutubeHostWideBlock,
  normalizeNodeKey,
  providerForSearchIdentifier,
};