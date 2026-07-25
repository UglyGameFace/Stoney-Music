"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const DEFAULT_CACHE_PATH = path.resolve(__dirname, "..", "data", "playback-match-cache.json");
const GOOD_MATCH_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const DEAD_MATCH_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_GOOD_MATCHES = 500;
const MAX_DEAD_MATCHES = 2_000;

function cleanTrackForCache(track = {}) {
  return {
    title: String(track.title || ""),
    author: String(track.author || ""),
    uri: String(track.uri || ""),
    artworkUrl: String(track.artworkUrl || ""),
    durationMs: Number(track.durationMs || 0),
    sourceName: String(track.sourceName || "unknown"),
    identifier: String(track.identifier || ""),
    isStream: Boolean(track.isStream),
    encoded: String(track.encoded || ""),
    playbackCandidateTitle: String(track.playbackCandidateTitle || track.title || ""),
    playbackCandidateAuthor: String(track.playbackCandidateAuthor || track.author || ""),
    playbackIdentity: track.playbackIdentity ? { ...track.playbackIdentity } : null,
    requestedQuery: String(track.requestedQuery || ""),
    fallbackFrom: String(track.fallbackFrom || ""),
    originalTitle: String(track.originalTitle || ""),
    originalUri: String(track.originalUri || ""),
    fallbackScore: Number(track.fallbackScore || 0),
    fallbackSource: String(track.fallbackSource || ""),
    isFallback: true,
  };
}

function trimNewest(object, limit) {
  const entries = Object.entries(object || {}).sort(
    (left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0)
  );
  return Object.fromEntries(entries.slice(0, limit));
}

class PlaybackMatchCache {
  constructor({ filePath = process.env.PLAYBACK_CACHE_PATH || DEFAULT_CACHE_PATH, logger = console } = {}) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
    this.matches = {};
    this.dead = {};
    this.loaded = false;
    this._writePromise = Promise.resolve();
  }

  async load() {
    if (this.loaded) return this;
    try {
      const parsed = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      this.matches = parsed?.matches && typeof parsed.matches === "object" ? parsed.matches : {};
      this.dead = parsed?.dead && typeof parsed.dead === "object" ? parsed.dead : {};
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger.warn?.("Could not read playback match cache", {
          path: this.filePath,
          message: error?.message || String(error),
        });
      }
    }
    this.loaded = true;
    this.prune();
    return this;
  }

  prune(now = Date.now()) {
    for (const [key, entry] of Object.entries(this.matches)) {
      if (!entry?.track?.encoded || now - Number(entry.updatedAt || 0) > GOOD_MATCH_TTL_MS) {
        delete this.matches[key];
      }
    }
    for (const [key, entry] of Object.entries(this.dead)) {
      if (now - Number(entry.updatedAt || 0) > DEAD_MATCH_TTL_MS) delete this.dead[key];
    }
    this.matches = trimNewest(this.matches, MAX_GOOD_MATCHES);
    this.dead = trimNewest(this.dead, MAX_DEAD_MATCHES);
  }

  get(identityKey, { requesterId = null } = {}) {
    this.prune();
    const entry = this.matches[String(identityKey || "")];
    if (!entry?.track?.encoded) return null;
    return {
      ...entry.track,
      requesterId,
      fallbackTriedKeys: [],
      fallbackCandidates: [],
      fallbackAttemptCount: 0,
      fallbackPlanResolved: false,
      fallbackVerified: false,
      fallbackPending: false,
    };
  }

  deadKeys() {
    this.prune();
    return Object.keys(this.dead);
  }

  isDead(candidateKey) {
    this.prune();
    return Boolean(this.dead[String(candidateKey || "")]);
  }

  async rememberGood(identityKey, candidateKey, track) {
    if (!identityKey || !candidateKey || !track?.encoded) return;
    delete this.dead[candidateKey];
    this.matches[identityKey] = {
      candidateKey,
      updatedAt: Date.now(),
      track: cleanTrackForCache(track),
    };
    this.prune();
    await this._write();
  }

  async rememberDead(identityKey, candidateKey, reason = "playback-failed") {
    if (!candidateKey) return;
    this.dead[candidateKey] = { updatedAt: Date.now(), reason: String(reason || "playback-failed") };
    if (identityKey && this.matches[identityKey]?.candidateKey === candidateKey) delete this.matches[identityKey];
    this.prune();
    await this._write();
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
          `${JSON.stringify({ version: 1, matches: this.matches, dead: this.dead }, null, 2)}\n`,
          { mode: 0o600 }
        );
        await fsp.rename(temporary, this.filePath);
      })
      .catch((error) => {
        this.logger.warn?.("Could not write playback match cache", {
          path: this.filePath,
          message: error?.message || String(error),
        });
      });
    return this._writePromise;
  }
}

module.exports = {
  DEAD_MATCH_TTL_MS,
  DEFAULT_CACHE_PATH,
  GOOD_MATCH_TTL_MS,
  MAX_DEAD_MATCHES,
  MAX_GOOD_MATCHES,
  PlaybackMatchCache,
  cleanTrackForCache,
  trimNewest,
};
