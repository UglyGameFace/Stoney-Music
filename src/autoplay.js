"use strict";

const { normalizeLoadResult, toQueueTrack } = require("./resolver");
const {
  cleanDisplayTitle,
  durationSimilarity,
  normalizeText,
  scorePlaybackCandidate,
  tokenSimilarity,
} = require("./playback-fallback");

const MUSICBRAINZ_ROOT = "https://musicbrainz.org/ws/2";
const LISTENBRAINZ_ROOT = "https://api.listenbrainz.org/1";
const USER_AGENT = "StoneyMusic/2.0 (https://github.com/UglyGameFace/Stoney-Music)";
const REQUEST_TIMEOUT_MS = 7_000;
const MUSICBRAINZ_INTERVAL_MS = 1_100;
const ARTIST_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const RADIO_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_RADIO_RECORDINGS = 24;
const MAX_CANDIDATES_TO_RESOLVE = 10;
const MAX_PROVIDER_RESULTS = 10;
const MINIMUM_EXACT_MATCH_SCORE = 0.58;
const DEFAULT_PROVIDER_PREFIXES = ["scsearch", "ytmsearch", "ytsearch"];
const BAD_VERSION_WORDS = new Set([
  "remix",
  "cover",
  "karaoke",
  "instrumental",
  "nightcore",
  "sped",
  "slowed",
  "reverb",
  "live",
  "concert",
  "tribute",
  "reaction",
  "tutorial",
  "mashup",
]);

const artistCache = new Map();
const radioCache = new Map();
let musicBrainzChain = Promise.resolve();
let nextMusicBrainzAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanArtistName(value) {
  return String(value || "")
    .replace(/\s+-\s+topic$/i, "")
    .replace(/\s+vevo$/i, "")
    .replace(/\s+official$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTrackKey(track) {
  const title = normalizeText(cleanDisplayTitle(track?.title || track?.name));
  const author = normalizeText(track?.author || track?.artist);
  return `${author}::${title}`;
}

function trackIdentitySet(tracks = []) {
  const identities = new Set();
  for (const item of tracks) {
    const key = canonicalTrackKey(item);
    if (key !== "::") identities.add(key);
    if (item?.identifier) identities.add(`id:${String(item.identifier)}`);
    if (item?.uri) identities.add(`uri:${String(item.uri)}`);
    if (item?.recordingMbid) identities.add(`mbid:${String(item.recordingMbid)}`);
  }
  return identities;
}

function hasIdentity(track, identities) {
  if (!track || !identities) return false;
  if (identities.has(canonicalTrackKey(track))) return true;
  if (track.identifier && identities.has(`id:${track.identifier}`)) return true;
  if (track.uri && identities.has(`uri:${track.uri}`)) return true;
  if (track.recordingMbid && identities.has(`mbid:${track.recordingMbid}`)) return true;
  return false;
}

function versionWords(value) {
  const words = normalizeText(value).split(/\s+/).filter(Boolean);
  return new Set(words.filter((word) => BAD_VERSION_WORDS.has(word)));
}

function isUnwantedVersion(seed, candidate) {
  const seedWords = versionWords(seed?.title);
  const candidateWords = versionWords(candidate?.title || candidate?.name);
  for (const word of candidateWords) {
    if (!seedWords.has(word)) return true;
  }
  return false;
}

async function fetchJson(fetchImpl, url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`HTTP ${response?.status || "unknown"}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function scheduleMusicBrainz(operation) {
  const run = musicBrainzChain.then(async () => {
    const waitMs = Math.max(0, nextMusicBrainzAt - Date.now());
    if (waitMs) await sleep(waitMs);
    try {
      return await operation();
    } finally {
      nextMusicBrainzAt = Date.now() + MUSICBRAINZ_INTERVAL_MS;
    }
  });
  musicBrainzChain = run.catch(() => {});
  return run;
}

function cacheGet(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(cache, key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

async function findArtistMbid(artistName, { fetchImpl = globalThis.fetch } = {}) {
  const cleaned = cleanArtistName(artistName);
  const cacheKey = normalizeText(cleaned);
  if (!cacheKey) return null;

  const cached = cacheGet(artistCache, cacheKey);
  if (cached !== null) return cached;

  const endpoint = new URL(`${MUSICBRAINZ_ROOT}/artist/`);
  endpoint.searchParams.set("query", `artist:\"${cleaned.replace(/\"/g, "")}\"`);
  endpoint.searchParams.set("fmt", "json");
  endpoint.searchParams.set("limit", "5");

  let payload;
  try {
    payload = await scheduleMusicBrainz(() => fetchJson(fetchImpl, endpoint.toString()));
  } catch {
    cacheSet(artistCache, cacheKey, null, 15 * 60 * 1_000);
    return null;
  }

  const artists = Array.isArray(payload?.artists) ? payload.artists : [];
  let best = null;
  for (const artist of artists) {
    if (!artist?.id || !artist?.name) continue;
    const apiScore = Number(artist.score || 0) / 100;
    const nameScore = tokenSimilarity(cleaned, artist.name);
    const exactBonus = normalizeText(cleaned) === normalizeText(artist.name) ? 0.3 : 0;
    const score = apiScore * 0.55 + nameScore * 0.45 + exactBonus;
    if (!best || score > best.score) best = { id: artist.id, name: artist.name, score };
  }

  const result = best && best.score >= 0.65 ? best : null;
  cacheSet(artistCache, cacheKey, result, ARTIST_CACHE_TTL_MS);
  return result;
}

function flattenRadioEntries(payload) {
  const entries = [];
  const visited = new Set();

  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    if (typeof value.recording_mbid === "string") {
      entries.push({
        recordingMbid: value.recording_mbid,
        similarArtistMbid: value.similar_artist_mbid || null,
        similarArtistName: value.similar_artist_name || null,
        totalListenCount: Number(value.total_listen_count || 0),
      });
    }

    for (const child of Object.values(value)) walk(child);
  }

  walk(payload);
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.recordingMbid || seen.has(entry.recordingMbid)) continue;
    seen.add(entry.recordingMbid);
    unique.push(entry);
  }
  return unique.slice(0, MAX_RADIO_RECORDINGS);
}

async function fetchRadioEntries(artistMbid, { fetchImpl = globalThis.fetch } = {}) {
  const cached = cacheGet(radioCache, artistMbid);
  if (cached !== null) return cached;

  const endpoint = new URL(`${LISTENBRAINZ_ROOT}/lb-radio/artist/${artistMbid}`);
  endpoint.searchParams.set("mode", "easy");
  endpoint.searchParams.set("max_similar_artists", "12");
  endpoint.searchParams.set("max_recordings_per_artist", "4");
  endpoint.searchParams.set("pop_begin", "20");
  endpoint.searchParams.set("pop_end", "100");

  try {
    const payload = await fetchJson(fetchImpl, endpoint.toString());
    return cacheSet(radioCache, artistMbid, flattenRadioEntries(payload), RADIO_CACHE_TTL_MS);
  } catch {
    return cacheSet(radioCache, artistMbid, [], 15 * 60 * 1_000);
  }
}

function artistCreditName(recording) {
  const credits = Array.isArray(recording?.["artist-credit"]) ? recording["artist-credit"] : [];
  const joined = credits
    .map((credit) => `${credit?.name || credit?.artist?.name || ""}${credit?.joinphrase || ""}`)
    .join("")
    .trim();
  return joined || "Unknown artist";
}

async function fetchRecordingMetadata(entries, { fetchImpl = globalThis.fetch } = {}) {
  const selected = entries.slice(0, MAX_RADIO_RECORDINGS);
  if (!selected.length) return [];

  const query = selected.map((entry) => `rid:${entry.recordingMbid}`).join(" OR ");
  const endpoint = new URL(`${MUSICBRAINZ_ROOT}/recording/`);
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("fmt", "json");
  endpoint.searchParams.set("limit", String(Math.min(100, selected.length)));

  let payload;
  try {
    payload = await scheduleMusicBrainz(() => fetchJson(fetchImpl, endpoint.toString()));
  } catch {
    return [];
  }

  const radioByMbid = new Map(selected.map((entry, index) => [entry.recordingMbid, { ...entry, index }]));
  const recordings = Array.isArray(payload?.recordings) ? payload.recordings : [];
  return recordings
    .map((recording) => {
      const radio = radioByMbid.get(recording?.id);
      if (!radio || !recording?.title) return null;
      return {
        title: recording.title,
        author: artistCreditName(recording),
        durationMs: Number(recording.length || 0),
        recordingMbid: recording.id,
        similarArtistName: radio.similarArtistName,
        totalListenCount: radio.totalListenCount,
        radioIndex: radio.index,
      };
    })
    .filter(Boolean);
}

function recentArtistCounts(history = []) {
  const counts = new Map();
  for (const item of history.slice(-8)) {
    const artist = normalizeText(item?.author);
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) || 0) + 1);
  }
  return counts;
}

function rankRadioCandidates(seed, candidates, history = [], random = Math.random) {
  const recentCounts = recentArtistCounts(history);
  const seedArtist = normalizeText(seed?.author);
  return candidates
    .map((candidate) => {
      const candidateArtist = normalizeText(candidate.author);
      const rankScore = Math.max(0, 1 - candidate.radioIndex / Math.max(1, candidates.length));
      const popularityScore = Math.min(1, Math.log10(candidate.totalListenCount + 1) / 7);
      const sameArtistBonus = candidateArtist === seedArtist ? 0.08 : 0;
      const repetitionPenalty = Math.min(0.55, (recentCounts.get(candidateArtist) || 0) * 0.17);
      const jitter = Number(random?.() || 0) * 0.09;
      return {
        ...candidate,
        recommendationScore:
          rankScore * 0.5 + popularityScore * 0.25 + sameArtistBonus - repetitionPenalty + jitter,
      };
    })
    .sort((left, right) => right.recommendationScore - left.recommendationScore);
}

function candidateInfo(candidate) {
  return {
    title: candidate.title,
    author: candidate.author,
    length: candidate.durationMs,
  };
}

async function resolveMetadataCandidate(
  candidate,
  {
    resolve,
    requesterId,
    identities,
    providerPrefixes = DEFAULT_PROVIDER_PREFIXES,
    minimumScore = MINIMUM_EXACT_MATCH_SCORE,
  }
) {
  const original = {
    title: candidate.title,
    author: candidate.author,
    durationMs: candidate.durationMs,
  };
  let best = null;
  const attempts = [];

  for (const prefix of providerPrefixes) {
    const identifier = `${prefix}:${candidate.author} - ${candidate.title}`;
    try {
      const result = normalizeLoadResult(await resolve(identifier));
      attempts.push({ source: prefix, loadType: result.loadType, count: result.tracks.length });
      for (const raw of result.tracks.slice(0, MAX_PROVIDER_RESULTS)) {
        const info = raw?.info || {};
        const prospective = {
          title: info.title,
          author: info.author,
          identifier: info.identifier,
          uri: info.uri,
        };
        if (hasIdentity(prospective, identities) || isUnwantedVersion(candidate, prospective)) continue;
        const score = scorePlaybackCandidate(original, raw) + (prefix === "scsearch" ? 0.025 : 0);
        if (!best || score > best.score) best = { raw, score, prefix };
      }
    } catch (error) {
      attempts.push({ source: prefix, loadType: "exception", count: 0, message: error?.message || String(error) });
    }
    if (best?.score >= 0.82) break;
  }

  if (!best || best.score < minimumScore) return { track: null, attempts, score: best?.score || 0 };
  const track = toQueueTrack(best.raw, requesterId || null);
  track.autoplay = true;
  track.autoplayProvider = "listenbrainz-radio";
  track.autoplaySource = best.prefix;
  track.autoplayScore = best.score;
  track.recordingMbid = candidate.recordingMbid || null;
  return { track, attempts, score: best.score, source: best.prefix };
}

async function resolveRadioRecommendation(
  seed,
  { resolve, fetchImpl = globalThis.fetch, history = [], queue = [], current = null, random = Math.random }
) {
  const artist = await findArtistMbid(seed?.author, { fetchImpl });
  if (!artist) return null;

  const radioEntries = await fetchRadioEntries(artist.id, { fetchImpl });
  if (!radioEntries.length) return null;
  const metadata = await fetchRecordingMetadata(radioEntries, { fetchImpl });
  if (!metadata.length) return null;

  const identities = trackIdentitySet([seed, current, ...history, ...queue].filter(Boolean));
  const ranked = rankRadioCandidates(seed, metadata, history, random).filter(
    (candidate) => !hasIdentity(candidate, identities) && !isUnwantedVersion(seed, candidate)
  );

  for (const candidate of ranked.slice(0, MAX_CANDIDATES_TO_RESOLVE)) {
    const resolved = await resolveMetadataCandidate(candidate, {
      resolve,
      requesterId: seed?.requesterId,
      identities,
    });
    if (!resolved.track) continue;
    resolved.track.autoplaySeedTitle = seed?.title || "";
    resolved.track.autoplaySeedAuthor = seed?.author || "";
    resolved.track.recommendedArtist = candidate.author;
    resolved.track.recommendationScore = candidate.recommendationScore;
    return {
      ...resolved,
      recommendationProvider: "listenbrainz-radio",
      seedArtistMbid: artist.id,
    };
  }
  return null;
}

function heuristicRelatedScore(seed, raw, history = [], random = Math.random) {
  const info = raw?.info || {};
  const title = cleanDisplayTitle(info.title);
  const authorScore = tokenSimilarity(cleanArtistName(seed?.author), cleanArtistName(info.author));
  const titleDuplicate = tokenSimilarity(cleanDisplayTitle(seed?.title), title);
  const durationScore = durationSimilarity(seed?.durationMs, info.length);
  const recentPenalty = recentArtistCounts(history).get(normalizeText(info.author)) || 0;
  return (
    authorScore * 0.62 +
    durationScore * 0.12 +
    Math.max(0, 1 - titleDuplicate) * 0.16 +
    Number(random?.() || 0) * 0.1 -
    Math.min(0.45, recentPenalty * 0.12)
  );
}

async function resolveHeuristicRecommendation(
  seed,
  { resolve, history = [], queue = [], current = null, random = Math.random }
) {
  const identities = trackIdentitySet([seed, current, ...history, ...queue].filter(Boolean));
  const artist = cleanArtistName(seed?.author);
  if (!artist) return null;

  const queries = [
    ["scsearch", artist],
    ["ytmsearch", `${artist} radio`],
    ["ytsearch", `${artist} similar songs`],
  ];
  let best = null;
  const attempts = [];

  for (const [prefix, query] of queries) {
    try {
      const result = normalizeLoadResult(await resolve(`${prefix}:${query}`));
      attempts.push({ source: prefix, loadType: result.loadType, count: result.tracks.length });
      for (const raw of result.tracks.slice(0, MAX_PROVIDER_RESULTS)) {
        const info = raw?.info || {};
        const prospective = {
          title: info.title,
          author: info.author,
          identifier: info.identifier,
          uri: info.uri,
        };
        if (hasIdentity(prospective, identities) || isUnwantedVersion(seed, prospective)) continue;
        if (!Number(info.length) || Number(info.length) < 60_000 || Number(info.length) > 15 * 60_000) continue;
        const score = heuristicRelatedScore(seed, raw, history, random) + (prefix === "scsearch" ? 0.03 : 0);
        if (!best || score > best.score) best = { raw, prefix, score };
      }
    } catch (error) {
      attempts.push({ source: prefix, loadType: "exception", count: 0, message: error?.message || String(error) });
    }
  }

  if (!best || best.score < 0.42) return { track: null, score: best?.score || 0, attempts };
  const track = toQueueTrack(best.raw, seed?.requesterId || null);
  track.autoplay = true;
  track.autoplayProvider = "provider-search";
  track.autoplaySource = best.prefix;
  track.autoplayScore = best.score;
  track.autoplaySeedTitle = seed?.title || "";
  track.autoplaySeedAuthor = seed?.author || "";
  return {
    track,
    source: best.prefix,
    score: best.score,
    attempts,
    recommendationProvider: "provider-search",
  };
}

async function resolveAutoplayRecommendation(
  seed,
  {
    resolve,
    fetchImpl = globalThis.fetch,
    history = [],
    queue = [],
    current = null,
    random = Math.random,
    logger = console,
  } = {}
) {
  if (typeof resolve !== "function") throw new TypeError("resolve must be a function");
  if (!seed?.title || !seed?.author) return null;

  try {
    const radio = await resolveRadioRecommendation(seed, {
      resolve,
      fetchImpl,
      history,
      queue,
      current,
      random,
    });
    if (radio?.track) return radio;
  } catch (error) {
    logger.warn?.("ListenBrainz autoplay radio failed; using provider-search fallback", {
      title: seed.title,
      artist: seed.author,
      message: error?.message || String(error),
    });
  }

  return resolveHeuristicRecommendation(seed, {
    resolve,
    history,
    queue,
    current,
    random,
  });
}

function clearAutoplayCaches() {
  artistCache.clear();
  radioCache.clear();
  musicBrainzChain = Promise.resolve();
  nextMusicBrainzAt = 0;
}

module.exports = {
  ARTIST_CACHE_TTL_MS,
  DEFAULT_PROVIDER_PREFIXES,
  MINIMUM_EXACT_MATCH_SCORE,
  RADIO_CACHE_TTL_MS,
  canonicalTrackKey,
  cleanArtistName,
  clearAutoplayCaches,
  fetchRadioEntries,
  fetchRecordingMetadata,
  findArtistMbid,
  flattenRadioEntries,
  hasIdentity,
  isUnwantedVersion,
  rankRadioCandidates,
  resolveAutoplayRecommendation,
  resolveHeuristicRecommendation,
  resolveRadioRecommendation,
  trackIdentitySet,
};
