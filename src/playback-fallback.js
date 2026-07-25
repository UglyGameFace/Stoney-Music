"use strict";

const { normalizeLoadResult, toQueueTrack } = require("./resolver");

const DEFAULT_PLAYBACK_FALLBACK_PREFIXES = ["scsearch"];
const DEFAULT_MINIMUM_MATCH_SCORE = 0.46;
const MAX_FALLBACK_CANDIDATES = 10;
const NOISE_WORDS = new Set([
  "official",
  "music",
  "video",
  "audio",
  "lyrics",
  "lyric",
  "visualizer",
  "visualiser",
  "hd",
  "hq",
  "4k",
  "explicit",
  "clean",
  "version",
  "topic",
  "provided",
  "youtube",
]);

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanDisplayTitle(value) {
  return String(value || "")
    .replace(
      /[\[(]\s*(?:official\s+)?(?:(?:music\s+)?video|audio|lyrics?|visuali[sz]er)\s*[\])]/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(value) {
  const tokens = normalizeText(value)
    .split(/\s+/)
    .filter((token) => token && !NOISE_WORDS.has(token));
  return new Set(tokens);
}

function tokenSimilarity(left, right) {
  const a = left instanceof Set ? left : tokenSet(left);
  const b = right instanceof Set ? right : tokenSet(right);
  if (!a.size || !b.size) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return (2 * intersection) / (a.size + b.size);
}

function durationSimilarity(leftMs, rightMs) {
  const left = Number(leftMs);
  const right = Number(rightMs);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return 0.5;

  const difference = Math.abs(left - right);
  const scale = Math.max(left, right, 1);
  return Math.max(0, 1 - difference / scale);
}

function buildPlaybackFallbackQuery(track) {
  const title = cleanDisplayTitle(track?.title);
  const author = String(track?.author || "").trim();
  if (!title) return author;
  if (!author) return title;

  const authorTokens = tokenSet(author);
  const titleTokens = tokenSet(title);
  const titleAlreadyNamesArtist =
    authorTokens.size > 0 && [...authorTokens].every((token) => titleTokens.has(token));

  return titleAlreadyNamesArtist ? title : `${author} - ${title}`;
}

function isYoutubeTrack(track) {
  const source = normalizeText(track?.sourceName);
  if (source.includes("youtube")) return true;

  try {
    const host = new URL(track?.uri || "").hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function scorePlaybackCandidate(original, candidate) {
  const info = candidate?.info || {};
  const titleScore = tokenSimilarity(cleanDisplayTitle(original?.title), cleanDisplayTitle(info.title));
  const authorScore = tokenSimilarity(original?.author, info.author);
  const timeScore = durationSimilarity(original?.durationMs, info.length);

  // Title is the strongest signal. Artist and duration prevent remixes, covers,
  // sped-up edits, and unrelated same-name songs from winning by accident.
  return titleScore * 0.58 + authorScore * 0.27 + timeScore * 0.15;
}

async function resolvePlaybackFallback(
  originalTrack,
  {
    resolve,
    prefixes = DEFAULT_PLAYBACK_FALLBACK_PREFIXES,
    minimumScore = DEFAULT_MINIMUM_MATCH_SCORE,
  } = {}
) {
  if (typeof resolve !== "function") throw new TypeError("resolve must be a function");
  if (!isYoutubeTrack(originalTrack)) return null;

  // The GuildPlayer owns the once-per-track attempt flag. It marks the current
  // item before calling this resolver so duplicate exception events cannot start
  // parallel searches. The resolver must still process that pre-marked item.
  const query = buildPlaybackFallbackQuery(originalTrack);
  if (!query) return null;

  const attempts = [];
  let best = null;

  for (const prefix of prefixes) {
    const identifier = `${prefix}:${query}`;
    try {
      const result = normalizeLoadResult(await resolve(identifier));
      attempts.push({ source: prefix, loadType: result.loadType, count: result.tracks.length });

      for (const candidate of result.tracks.slice(0, MAX_FALLBACK_CANDIDATES)) {
        const score = scorePlaybackCandidate(originalTrack, candidate);
        if (!best || score > best.score) best = { candidate, prefix, score };
      }
    } catch (error) {
      attempts.push({
        source: prefix,
        loadType: "exception",
        count: 0,
        message: error?.message || String(error),
      });
    }
  }

  if (!best || best.score < minimumScore) {
    return { track: null, query, score: best?.score || 0, attempts };
  }

  const replacement = toQueueTrack(best.candidate, originalTrack.requesterId);
  replacement.fallbackAttempted = true;
  replacement.fallbackFrom = originalTrack.sourceName || "youtube";
  replacement.originalTitle = originalTrack.title || replacement.title;
  replacement.originalUri = originalTrack.uri || "";

  return {
    track: replacement,
    source: best.prefix,
    query,
    score: best.score,
    attempts,
  };
}

module.exports = {
  DEFAULT_MINIMUM_MATCH_SCORE,
  DEFAULT_PLAYBACK_FALLBACK_PREFIXES,
  MAX_FALLBACK_CANDIDATES,
  buildPlaybackFallbackQuery,
  cleanDisplayTitle,
  durationSimilarity,
  isYoutubeTrack,
  normalizeText,
  resolvePlaybackFallback,
  scorePlaybackCandidate,
  tokenSet,
  tokenSimilarity,
};
