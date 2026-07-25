"use strict";

const { normalizeLoadResult, toQueueTrack } = require("./resolver");

const DEFAULT_PLAYBACK_FALLBACK_PREFIXES = ["scsearch", "bcsearch", "ytmsearch", "ytsearch"];
const DEFAULT_MINIMUM_MATCH_SCORE = 0.72;
const MAX_FALLBACK_CANDIDATES_PER_SOURCE = 10;
const MAX_FALLBACK_PLAN_SIZE = 8;
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
const VERSION_MARKERS = Object.freeze([
  "remix",
  "mix",
  "mashup",
  "cover",
  "karaoke",
  "instrumental",
  "acoustic",
  "live",
  "concert",
  "sped up",
  "speed up",
  "slowed",
  "reverb",
  "nightcore",
  "edit",
  "bootleg",
  "tribute",
  "piano",
  "8d",
  "radio edit",
  "extended",
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

function identityForTrack(track = {}) {
  const identity = track.playbackIdentity || {};
  return {
    title: identity.title || track.title || track.playbackCandidateTitle || "",
    artist: identity.artist || track.author || track.playbackCandidateAuthor || "",
    album: identity.album || "",
    artworkUrl: identity.artworkUrl || track.artworkUrl || "",
    durationMs: Number(identity.durationMs || track.durationMs || 0),
    durationTrusted: Boolean(identity.durationTrusted),
    sourceType: identity.sourceType || track.sourceName || "unknown",
    sourceId: identity.sourceId || "",
    sourceUrl: identity.sourceUrl || track.uri || "",
    requestedQuery: identity.requestedQuery || track.requestedQuery || "",
  };
}

function fallbackIdentityKey(track) {
  const identity = identityForTrack(track);
  return [normalizeText(identity.artist), normalizeText(identity.title), Math.round(identity.durationMs / 1000)]
    .join("|")
    .slice(0, 500);
}

function playbackCandidateKey(track = {}) {
  return [track.sourceName, track.identifier, track.uri, track.encoded]
    .map((value) => String(value || "").trim())
    .join("|")
    .slice(0, 2_000);
}

function providerForPrefix(prefix) {
  const normalized = normalizeText(prefix);
  if (normalized.startsWith("sc")) return "soundcloud";
  if (normalized.startsWith("bc")) return "bandcamp";
  if (normalized.startsWith("yt")) return "youtube";
  return normalized || "unknown";
}

function providerForTrack(track = {}) {
  const source = normalizeText(track.sourceName);
  if (source.includes("soundcloud")) return "soundcloud";
  if (source.includes("bandcamp")) return "bandcamp";
  if (source.includes("youtube")) return "youtube";
  return source || "unknown";
}

function buildPlaybackFallbackQuery(track) {
  const identity = identityForTrack(track);
  const title = cleanDisplayTitle(identity.title);
  const artist = String(identity.artist || "").trim();
  if (!title) return artist;
  if (!artist) return title;

  const artistTokens = tokenSet(artist);
  const titleTokens = tokenSet(title);
  const titleAlreadyNamesArtist =
    artistTokens.size > 0 && [...artistTokens].every((token) => titleTokens.has(token));

  return titleAlreadyNamesArtist ? title : `${artist} - ${title}`;
}

function isYoutubeTrack(track) {
  return providerForTrack(track) === "youtube";
}

function titleCore(value, artist = "") {
  const cleaned = cleanDisplayTitle(value);
  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length > 1 && tokenSimilarity(parts[0], artist) >= 0.55) {
    return parts.slice(1).join(" - ").trim();
  }
  return cleaned;
}

function markerSet(value) {
  const padded = ` ${normalizeText(value)} `;
  return new Set(
    VERSION_MARKERS.filter((marker) => padded.includes(` ${normalizeText(marker)} `))
  );
}

function unexpectedVersionMarkers(originalTitle, candidateTitle) {
  const allowed = markerSet(originalTitle);
  return [...markerSet(candidateTitle)].filter((marker) => !allowed.has(marker));
}

function evaluatePlaybackCandidate(original, candidate) {
  const identity = identityForTrack(original);
  const info = candidate?.info || {};
  const originalTitle = titleCore(identity.title, identity.artist);
  const candidateTitle = titleCore(info.title, identity.artist);
  const titleScore = tokenSimilarity(originalTitle, candidateTitle);
  const authorScore = Math.max(
    tokenSimilarity(identity.artist, info.author),
    tokenSimilarity(identity.artist, cleanDisplayTitle(info.title)) * 0.92
  );
  const timeScore = durationSimilarity(identity.durationMs, info.length);
  const variants = unexpectedVersionMarkers(identity.title, info.title);
  const durationDifference = Math.abs(Number(identity.durationMs || 0) - Number(info.length || 0));
  const durationTolerance = identity.durationTrusted
    ? Math.max(12_000, Number(identity.durationMs || 0) * 0.08)
    : Math.max(25_000, Number(identity.durationMs || 0) * 0.15);

  const reasons = [];
  if (variants.length) reasons.push(`alternate-version:${variants.join(",")}`);
  if (titleScore < 0.78) reasons.push(`title:${titleScore.toFixed(3)}`);
  if (identity.artist && authorScore < 0.58) reasons.push(`artist:${authorScore.toFixed(3)}`);
  if (
    identity.durationMs > 0 &&
    Number(info.length || 0) > 0 &&
    durationDifference > durationTolerance
  ) {
    reasons.push(`duration:${Math.round(durationDifference / 1000)}s`);
  }

  const score = titleScore * 0.56 + authorScore * 0.31 + timeScore * 0.13;
  return {
    accepted: reasons.length === 0 && score >= DEFAULT_MINIMUM_MATCH_SCORE,
    score,
    titleScore,
    authorScore,
    timeScore,
    reasons,
  };
}

function scorePlaybackCandidate(original, candidate) {
  return evaluatePlaybackCandidate(original, candidate).score;
}

function copyPlaybackIdentity(original, replacement) {
  const identity = identityForTrack(original);
  replacement.title = identity.title || replacement.title;
  replacement.author = identity.artist || replacement.author;
  replacement.artworkUrl = identity.artworkUrl || replacement.artworkUrl;
  replacement.durationMs = identity.durationMs || replacement.durationMs;
  replacement.playbackIdentity = { ...identity };
  replacement.requestedQuery = identity.requestedQuery || original.requestedQuery || "";
  replacement.fallbackFrom = original.fallbackFrom || original.sourceName || "unknown";
  replacement.originalTitle = original.originalTitle || identity.title || original.title || replacement.title;
  replacement.originalUri = original.originalUri || identity.sourceUrl || original.uri || "";
  replacement.fallbackAttemptCount = Number(original.fallbackAttemptCount || 0);
  replacement.fallbackTriedKeys = [...new Set(original.fallbackTriedKeys || [])];
  replacement.playbackCandidateTitle ||= replacement.title;
  replacement.playbackCandidateAuthor ||= replacement.author;
  replacement.isFallback = true;
  replacement.fallbackVerified = false;
  return replacement;
}

async function resolvePlaybackFallback(
  originalTrack,
  {
    resolve,
    prefixes = DEFAULT_PLAYBACK_FALLBACK_PREFIXES,
    minimumScore = DEFAULT_MINIMUM_MATCH_SCORE,
    triedKeys = originalTrack?.fallbackTriedKeys || [],
    cachedCandidates = [],
    deadKeys = [],
  } = {}
) {
  if (typeof resolve !== "function") throw new TypeError("resolve must be a function");

  const query = buildPlaybackFallbackQuery(originalTrack);
  if (!query) return { track: null, candidates: [], query, score: 0, attempts: [], rejections: [] };

  const failedProvider = providerForTrack(originalTrack);
  const blockedKeys = new Set([...triedKeys, ...deadKeys, playbackCandidateKey(originalTrack)].filter(Boolean));
  const attempts = [];
  const rejections = [];
  const ranked = [];
  const seen = new Set();

  const considerQueueTrack = (queueTrack, source, score, details = {}) => {
    const key = playbackCandidateKey(queueTrack);
    if (!key || blockedKeys.has(key) || seen.has(key)) return;
    seen.add(key);
    ranked.push({ track: queueTrack, source, score, ...details });
  };

  for (const cached of cachedCandidates) {
    const key = playbackCandidateKey(cached);
    if (!key || blockedKeys.has(key) || seen.has(key)) continue;
    const clone = copyPlaybackIdentity(originalTrack, { ...cached, fallbackTriedKeys: [...(cached.fallbackTriedKeys || [])] });
    considerQueueTrack(clone, clone.sourceName || "cache", 1.01, { cached: true });
  }

  for (const prefix of prefixes) {
    const provider = providerForPrefix(prefix);
    if (provider === failedProvider) {
      attempts.push({ source: prefix, loadType: "skipped-same-provider", count: 0 });
      continue;
    }

    const identifier = `${prefix}:${query}`;
    try {
      const result = normalizeLoadResult(await resolve(identifier));
      attempts.push({ source: prefix, loadType: result.loadType, count: result.tracks.length });

      for (const candidate of result.tracks.slice(0, MAX_FALLBACK_CANDIDATES_PER_SOURCE)) {
        const rawKey = playbackCandidateKey({
          sourceName: candidate.info?.sourceName,
          identifier: candidate.info?.identifier,
          uri: candidate.info?.uri,
          encoded: candidate.encoded || candidate.track,
        });
        if (blockedKeys.has(rawKey) || seen.has(rawKey)) continue;

        const evaluation = evaluatePlaybackCandidate(originalTrack, candidate);
        if (!evaluation.accepted || evaluation.score < minimumScore) {
          rejections.push({
            source: prefix,
            title: candidate.info?.title || "Unknown title",
            author: candidate.info?.author || "Unknown artist",
            score: evaluation.score,
            reasons: evaluation.reasons,
          });
          continue;
        }

        const replacement = copyPlaybackIdentity(
          originalTrack,
          toQueueTrack(candidate, originalTrack.requesterId)
        );
        replacement.fallbackScore = evaluation.score;
        replacement.fallbackSource = prefix;
        considerQueueTrack(replacement, prefix, evaluation.score, { evaluation });
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

  ranked.sort((left, right) => right.score - left.score);
  const candidates = ranked.slice(0, MAX_FALLBACK_PLAN_SIZE).map((entry) => {
    entry.track.fallbackScore = entry.score;
    entry.track.fallbackSource = entry.source;
    return entry.track;
  });

  return {
    track: candidates[0] || null,
    candidates,
    source: ranked[0]?.source || null,
    query,
    score: ranked[0]?.score || 0,
    attempts,
    rejections,
  };
}

module.exports = {
  DEFAULT_MINIMUM_MATCH_SCORE,
  DEFAULT_PLAYBACK_FALLBACK_PREFIXES,
  MAX_FALLBACK_CANDIDATES_PER_SOURCE,
  MAX_FALLBACK_PLAN_SIZE,
  VERSION_MARKERS,
  buildPlaybackFallbackQuery,
  cleanDisplayTitle,
  copyPlaybackIdentity,
  durationSimilarity,
  evaluatePlaybackCandidate,
  fallbackIdentityKey,
  identityForTrack,
  isYoutubeTrack,
  normalizeText,
  playbackCandidateKey,
  providerForPrefix,
  providerForTrack,
  resolvePlaybackFallback,
  scorePlaybackCandidate,
  tokenSet,
  tokenSimilarity,
  unexpectedVersionMarkers,
};
