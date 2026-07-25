"use strict";

const {
  MusicResolutionError,
  attachTrackIdentity,
  normalizeIdentity,
  normalizeLoadResult,
} = require("./resolver");

const DEFAULT_STRICT_SEARCH_PREFIXES = ["ytsearch", "ytmsearch", "scsearch", "bcsearch"];
const MAX_INITIAL_CANDIDATES_PER_SOURCE = 10;
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
  return new Set(
    normalizeText(value)
      .split(/\s+/)
      .filter((token) => token && !NOISE_WORDS.has(token))
  );
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

function markerSet(value) {
  const padded = ` ${normalizeText(value)} `;
  return new Set(
    VERSION_MARKERS.filter((marker) => padded.includes(` ${normalizeText(marker)} `))
  );
}

function unexpectedVersionMarkers(requestedTitle, candidateTitle) {
  const allowed = markerSet(requestedTitle);
  return [...markerSet(candidateTitle)].filter((marker) => !allowed.has(marker));
}

function titleCore(value, artist = "") {
  const cleaned = cleanDisplayTitle(value);
  const parts = cleaned.split(/\s+-\s+/);
  if (parts.length > 1 && tokenSimilarity(parts[0], artist) >= 0.55) {
    return parts.slice(1).join(" - ").trim();
  }
  return cleaned;
}

function durationSimilarity(leftMs, rightMs) {
  const left = Number(leftMs);
  const right = Number(rightMs);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return 0.5;
  return Math.max(0, 1 - Math.abs(left - right) / Math.max(left, right, 1));
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripArtistFromQuery(query, artist) {
  const value = String(query || "").trim();
  const name = String(artist || "").trim();
  if (!value || !name) return value;
  const escaped = escapeRegExp(name);
  return value
    .replace(new RegExp(`^${escaped}\\s*(?:[-–—:|]\\s*)?`, "i"), "")
    .replace(new RegExp(`\\s*(?:[-–—:|]\\s*)?${escaped}$`, "i"), "")
    .trim();
}

function manualIdentityFromQuery(query, track = null) {
  const value = String(query || "").trim();
  const info = track?.info || {};
  const separated = value.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  const artist = separated?.[1]?.trim() || "";
  const title = separated?.[2]?.trim() || value;
  return normalizeIdentity({
    title,
    artist,
    artworkUrl: info.artworkUrl || "",
    durationMs: 0,
    durationTrusted: false,
    sourceType: "manual-search",
    sourceId: info.identifier || "",
    sourceUrl: info.uri || "",
    requestedQuery: value,
  });
}

function identityForResult(query, resultSource, track) {
  const existing = track?.stoneyIdentity ? normalizeIdentity(track.stoneyIdentity) : null;
  if (existing && existing.sourceType !== "manual-search") return existing;
  if (["apple-music-metadata", "spotify-oembed"].includes(resultSource) && existing) return existing;
  return manualIdentityFromQuery(query, track);
}

function evaluateInitialCandidate(identityInput, candidate) {
  const identity = normalizeIdentity(identityInput);
  const info = candidate?.info || {};
  const variants = unexpectedVersionMarkers(identity.title || identity.requestedQuery, info.title);
  const reasons = [];
  if (variants.length) reasons.push(`alternate-version:${variants.join(",")}`);

  if (!identity.artist) {
    const titleScore = Math.max(
      tokenSimilarity(identity.title, titleCore(info.title, info.author)),
      tokenSimilarity(identity.title, `${info.author || ""} ${cleanDisplayTitle(info.title)}`)
    );
    if (titleScore < 0.72) reasons.push(`query:${titleScore.toFixed(3)}`);
    return { accepted: reasons.length === 0, score: titleScore, reasons };
  }

  const titleScore = tokenSimilarity(
    titleCore(identity.title, identity.artist),
    titleCore(info.title, identity.artist)
  );
  const artistScore = Math.max(
    tokenSimilarity(identity.artist, info.author),
    tokenSimilarity(identity.artist, cleanDisplayTitle(info.title)) * 0.92
  );
  const timeScore = durationSimilarity(identity.durationMs, info.length);
  const difference = Math.abs(Number(identity.durationMs || 0) - Number(info.length || 0));
  const tolerance = identity.durationTrusted
    ? Math.max(12_000, Number(identity.durationMs || 0) * 0.08)
    : Math.max(25_000, Number(identity.durationMs || 0) * 0.15);

  if (titleScore < 0.78) reasons.push(`title:${titleScore.toFixed(3)}`);
  if (artistScore < 0.58) reasons.push(`artist:${artistScore.toFixed(3)}`);
  if (identity.durationMs > 0 && Number(info.length || 0) > 0 && difference > tolerance) {
    reasons.push(`duration:${Math.round(difference / 1000)}s`);
  }

  const score = titleScore * 0.56 + artistScore * 0.31 + timeScore * 0.13;
  if (score < 0.72) reasons.push(`score:${score.toFixed(3)}`);
  return { accepted: reasons.length === 0, score, reasons };
}

function candidateKey(candidate = {}) {
  const info = candidate.info || {};
  return [info.sourceName, info.identifier, info.uri, candidate.encoded || candidate.track]
    .map((value) => String(value || ""))
    .join("|");
}

function selectStrictInitialCandidate(tracks, identity) {
  const ranked = [];
  const rejections = [];
  const seen = new Set();
  for (const candidate of (tracks || []).slice(0, MAX_INITIAL_CANDIDATES_PER_SOURCE)) {
    const key = candidateKey(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const evaluation = evaluateInitialCandidate(identity, candidate);
    if (evaluation.accepted) ranked.push({ candidate, ...evaluation });
    else {
      rejections.push({
        title: candidate.info?.title || "Unknown title",
        author: candidate.info?.author || "Unknown artist",
        score: evaluation.score,
        reasons: evaluation.reasons,
      });
    }
  }
  ranked.sort((left, right) => right.score - left.score);
  return { track: ranked[0]?.candidate || null, score: ranked[0]?.score || 0, rejections };
}

function prefixForTrack(track) {
  const source = normalizeText(track?.info?.sourceName);
  if (source.includes("youtube")) return "ytsearch";
  if (source.includes("soundcloud")) return "scsearch";
  if (source.includes("bandcamp")) return "bcsearch";
  return null;
}

async function findStrictReplacement(identity, query, currentTrack, { resolve, attempts }) {
  const preferred = prefixForTrack(currentTrack);
  const prefixes = [preferred, ...DEFAULT_STRICT_SEARCH_PREFIXES].filter(
    (prefix, index, all) => prefix && all.indexOf(prefix) === index
  );
  const accepted = [];
  const rejections = [];
  const seen = new Set();

  for (const prefix of prefixes) {
    try {
      const result = normalizeLoadResult(await resolve(`${prefix}:${query}`));
      const selected = selectStrictInitialCandidate(result.tracks, identity);
      attempts.push({
        source: `strict-${prefix}`,
        loadType: result.loadType,
        count: result.tracks.length,
        safeCount: selected.track ? 1 : 0,
        bestScore: selected.score,
      });
      rejections.push(...selected.rejections.map((entry) => ({ source: prefix, ...entry })));
      for (const candidate of result.tracks.slice(0, MAX_INITIAL_CANDIDATES_PER_SOURCE)) {
        const key = candidateKey(candidate);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const evaluation = evaluateInitialCandidate(identity, candidate);
        if (evaluation.accepted) accepted.push({ track: candidate, prefix, ...evaluation });
      }
    } catch (error) {
      attempts.push({
        source: `strict-${prefix}`,
        loadType: "exception",
        count: 0,
        message: error?.message || String(error),
      });
    }
  }

  accepted.sort((left, right) => right.score - left.score);
  return { track: accepted[0]?.track || null, source: accepted[0]?.prefix || null, rejections };
}

function finalizeIdentity(identityInput, query, selected) {
  const identity = normalizeIdentity(identityInput);
  const info = selected?.info || {};
  if (identity.sourceType !== "manual-search") return identity;

  const inferredArtist = identity.artist || info.author || "";
  const stripped = stripArtistFromQuery(query, inferredArtist);
  return normalizeIdentity({
    ...identity,
    title: identity.artist ? identity.title : stripped || cleanDisplayTitle(info.title) || identity.title,
    artist: inferredArtist,
    artworkUrl: info.artworkUrl || identity.artworkUrl,
    durationMs: Number(info.length || 0),
    sourceId: info.identifier || identity.sourceId,
    sourceUrl: info.uri || identity.sourceUrl,
  });
}

async function refineInitialResolution(result, query, { resolve } = {}) {
  if (!result || !Array.isArray(result.tracks) || !result.tracks.length) return result;
  if (result.source === "direct") return result;
  if (typeof resolve !== "function") throw new TypeError("resolve must be a function");

  const attempts = Array.isArray(result.attempts) ? result.attempts : [];
  const refined = [];
  const skipped = [];

  for (const current of result.tracks) {
    const identity = identityForResult(query, result.source, current);
    const currentEvaluation = evaluateInitialCandidate(identity, current);
    let selected = currentEvaluation.accepted ? current : null;

    if (!selected) {
      const searchText = [identity.artist, identity.title].filter(Boolean).join(" - ") || query;
      const replacement = await findStrictReplacement(identity, searchText, current, {
        resolve,
        attempts,
      });
      selected = replacement.track;
      if (!selected) {
        skipped.push({
          title: identity.title || query,
          artist: identity.artist,
          reasons: [...currentEvaluation.reasons, ...replacement.rejections.slice(0, 5)],
        });
        continue;
      }
    }

    const finalized = finalizeIdentity(identity, query, selected);
    attachTrackIdentity(selected, finalized);
    refined.push(selected);
  }

  if (!refined.length) {
    throw new MusicResolutionError("No strict original-version match was found.", {
      code: "STRICT_MATCH_EMPTY",
      userMessage:
        "The song was identified, but only mismatched covers, remixes, live versions, or unrelated results were found.",
      attempts,
    });
  }

  const notices = [...(result.notices || [])];
  if (skipped.length) notices.push(`Skipped ${skipped.length} item(s) with no strict original-version match.`);
  return { ...result, tracks: refined, notices, attempts };
}

module.exports = {
  DEFAULT_STRICT_SEARCH_PREFIXES,
  MAX_INITIAL_CANDIDATES_PER_SOURCE,
  VERSION_MARKERS,
  cleanDisplayTitle,
  evaluateInitialCandidate,
  finalizeIdentity,
  identityForResult,
  manualIdentityFromQuery,
  refineInitialResolution,
  selectStrictInitialCandidate,
  stripArtistFromQuery,
  tokenSimilarity,
  unexpectedVersionMarkers,
};
