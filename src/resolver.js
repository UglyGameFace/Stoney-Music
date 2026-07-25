"use strict";

const DEFAULT_SEARCH_PREFIXES = ["ytsearch", "ytmsearch", "scsearch"];
const MAX_PLAYLIST_TRACKS = 100;
const MAX_METADATA_TRACKS = 50;
const REQUEST_TIMEOUT_MS = 8_000;

class MusicResolutionError extends Error {
  constructor(message, { code = "RESOLUTION_FAILED", userMessage = null, attempts = [] } = {}) {
    super(message);
    this.name = "MusicResolutionError";
    this.code = code;
    this.userMessage = userMessage || message;
    this.attempts = attempts;
  }
}

function canonicalLoadType(loadType) {
  const normalized = String(loadType || "").trim().toLowerCase();
  const aliases = {
    track_loaded: "track",
    playlist_loaded: "playlist",
    search_result: "search",
    no_matches: "empty",
    load_failed: "error",
  };
  return aliases[normalized] || normalized || "empty";
}

function hasEncodedTrack(track) {
  return Boolean(track && typeof (track.encoded || track.track) === "string" && (track.encoded || track.track));
}

function normalizeLoadResult(result) {
  const loadType = canonicalLoadType(result?.loadType);
  const data = result?.data;
  let tracks = [];
  let playlistInfo = null;
  let error = null;

  if (loadType === "track") {
    tracks = data ? [data] : [];
  } else if (loadType === "search") {
    tracks = Array.isArray(data) ? data : [];
  } else if (loadType === "playlist") {
    tracks = Array.isArray(data?.tracks) ? data.tracks : [];
    playlistInfo = data?.info || null;
  } else if (loadType === "error") {
    error = data || result?.exception || null;
  }

  // Compatibility with older Lavalink/Shoukaku response shapes.
  if (!tracks.length && Array.isArray(result?.tracks)) {
    tracks = result.tracks;
  }

  return {
    loadType,
    tracks: tracks.filter(hasEncodedTrack),
    playlistInfo,
    error,
  };
}

function toQueueTrack(track, requesterId) {
  if (!hasEncodedTrack(track)) {
    throw new MusicResolutionError("Lavalink returned a track without encoded audio data.", {
      code: "INVALID_TRACK",
      userMessage: "The source returned an unusable track. Try another link or search.",
    });
  }

  const info = track.info || {};
  return {
    title: info.title || "Unknown title",
    author: info.author || "Unknown artist",
    uri: info.uri || "",
    artworkUrl: info.artworkUrl || "",
    durationMs: Number.isFinite(info.length) ? info.length : 0,
    sourceName: info.sourceName || "unknown",
    identifier: info.identifier || "",
    isStream: Boolean(info.isStream),
    encoded: track.encoded || track.track,
    requesterId,
  };
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function cleanHost(hostname) {
  return String(hostname || "").toLowerCase().replace(/^www\./, "");
}

function isAppleMusicUrl(value) {
  const url = parseUrl(value);
  return Boolean(url && cleanHost(url.hostname) === "music.apple.com");
}

function isSpotifyUrl(value) {
  const url = parseUrl(value);
  if (!url) return false;
  const host = cleanHost(url.hostname);
  return host === "open.spotify.com" || host === "spotify.link";
}

function safeAttemptLabel(identifier) {
  const value = String(identifier || "");
  if (/^https?:\/\//i.test(value)) {
    const url = parseUrl(value);
    return url ? `url:${cleanHost(url.hostname)}${url.pathname}` : "url:invalid";
  }
  const colon = value.indexOf(":");
  return colon > 0 ? value.slice(0, colon) : "search";
}

async function resolveIdentifier(resolve, identifier, attempts) {
  const label = safeAttemptLabel(identifier);
  try {
    const result = normalizeLoadResult(await resolve(identifier));
    attempts.push({ source: label, loadType: result.loadType, count: result.tracks.length });
    return result;
  } catch (error) {
    attempts.push({ source: label, loadType: "exception", count: 0, message: error?.message || String(error) });
    return { loadType: "error", tracks: [], playlistInfo: null, error };
  }
}

function buildSearchText(metadata) {
  return [metadata.artist, metadata.title].filter(Boolean).join(" - ").trim();
}

async function resolveSearchText(resolve, text, attempts, prefixes = DEFAULT_SEARCH_PREFIXES) {
  const query = String(text || "").trim();
  if (!query) return null;

  for (const prefix of prefixes) {
    const result = await resolveIdentifier(resolve, `${prefix}:${query}`, attempts);
    if (result.tracks.length) {
      return { track: result.tracks[0], source: prefix };
    }
  }
  return null;
}

async function expandRedirectUrl(fetchImpl, url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "StoneyMusic/2.0 (+Discord music resolver)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Short-link expansion failed with HTTP ${response.status}`);
    }
    const expanded = String(response.url || "").trim();
    const parsed = parseUrl(expanded);
    if (!parsed || cleanHost(parsed.hostname) !== "open.spotify.com") {
      throw new Error("Spotify short link did not resolve to open.spotify.com");
    }
    return parsed.toString();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(fetchImpl, url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": "StoneyMusic/2.0 (+Discord music resolver)",
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Metadata request failed with HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function appleLinkDetails(value) {
  const url = parseUrl(value);
  if (!url || cleanHost(url.hostname) !== "music.apple.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  const storefront = /^[a-z]{2}$/i.test(segments[0] || "") ? segments[0].toLowerCase() : "us";
  const typeIndex = segments.findIndex((segment) => ["song", "album", "playlist"].includes(segment));
  const type = typeIndex >= 0 ? segments[typeIndex] : null;
  const finalSegment = segments.at(-1) || "";
  const selectedSongId = url.searchParams.get("i");

  if (selectedSongId && /^\d+$/.test(selectedSongId)) {
    return { type: "song", id: selectedSongId, storefront };
  }
  if ((type === "song" || type === "album") && /^\d+$/.test(finalSegment)) {
    return { type, id: finalSegment, storefront };
  }
  if (type === "playlist") {
    return { type: "playlist", id: finalSegment, storefront };
  }
  return { type: "unknown", id: finalSegment, storefront };
}

function appleTrackMetadata(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  return results
    .filter((item) => item && item.wrapperType === "track" && item.trackName)
    .map((item) => ({
      title: item.trackName,
      artist: item.artistName || "",
      album: item.collectionName || "",
      durationMs: Number.isFinite(item.trackTimeMillis) ? item.trackTimeMillis : 0,
    }));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function resolveMetadataCollection({ resolve, metadata, attempts, limit = MAX_METADATA_TRACKS }) {
  const selected = metadata.slice(0, limit);
  const matches = await mapWithConcurrency(selected, 3, async (item) => {
    const searchText = buildSearchText(item);
    const match = await resolveSearchText(resolve, searchText, attempts);
    return { item, searchText, match };
  });

  const resolved = [];
  const skipped = [];
  for (const { item, searchText, match } of matches) {
    if (match) resolved.push(match.track);
    else skipped.push(searchText || item.title || "Unknown track");
  }
  return { resolved, skipped };
}

async function resolveAppleMusic(value, { resolve, fetchImpl, attempts }) {
  const details = appleLinkDetails(value);
  if (!details || details.type === "unknown") {
    throw new MusicResolutionError("Unsupported Apple Music link format.", {
      code: "APPLE_LINK_UNSUPPORTED",
      userMessage: "That Apple Music link format is not supported. Use a song or album link.",
      attempts,
    });
  }

  if (details.type === "playlist") {
    throw new MusicResolutionError("Apple Music playlist expansion requires Apple Music API credentials.", {
      code: "APPLE_PLAYLIST_CREDENTIALS_REQUIRED",
      userMessage:
        "Apple Music playlists still require Apple Music API credentials. Song and album links work without them.",
      attempts,
    });
  }

  const endpoint = new URL("https://itunes.apple.com/lookup");
  endpoint.searchParams.set("id", details.id);
  endpoint.searchParams.set("country", details.storefront.toUpperCase());
  if (details.type === "album") {
    endpoint.searchParams.set("entity", "song");
    endpoint.searchParams.set("limit", String(MAX_METADATA_TRACKS + 1));
  }

  let payload;
  try {
    payload = await fetchJson(fetchImpl, endpoint.toString());
    attempts.push({ source: "apple-itunes-lookup", loadType: "metadata", count: payload?.resultCount || 0 });
  } catch (error) {
    throw new MusicResolutionError(`Apple metadata lookup failed: ${error?.message || error}`, {
      code: "APPLE_METADATA_FAILED",
      userMessage: "Apple Music metadata could not be read right now. Try again shortly.",
      attempts,
    });
  }

  const metadata = appleTrackMetadata(payload);
  if (!metadata.length) {
    throw new MusicResolutionError("Apple Music lookup returned no playable song metadata.", {
      code: "APPLE_METADATA_EMPTY",
      userMessage: "No songs could be read from that Apple Music link.",
      attempts,
    });
  }

  const { resolved, skipped } = await resolveMetadataCollection({ resolve, metadata, attempts });
  if (!resolved.length) {
    throw new MusicResolutionError("No Apple Music metadata matches were playable through configured providers.", {
      code: "APPLE_NO_PLAYABLE_MATCH",
      userMessage: "The Apple Music songs were found, but no playable matches were available.",
      attempts,
    });
  }

  return {
    tracks: resolved,
    source: "apple-music-metadata",
    playlistName: details.type === "album" ? metadata[0]?.album || "Apple Music album" : null,
    notices: skipped.length ? [`Skipped ${skipped.length} song(s) with no playable match.`] : [],
  };
}

function spotifyLinkType(value) {
  const url = parseUrl(value);
  if (!url) return null;
  const segments = url.pathname.split("/").filter(Boolean).filter((segment) => !/^intl-[a-z]{2}$/i.test(segment));
  const type = segments.find((segment) => ["track", "episode", "album", "playlist", "artist", "show"].includes(segment));
  return type || null;
}

async function resolveSpotify(value, { resolve, fetchImpl, attempts }) {
  let canonicalUrl = value;
  const initialUrl = parseUrl(value);
  if (initialUrl && cleanHost(initialUrl.hostname) === "spotify.link") {
    try {
      canonicalUrl = await expandRedirectUrl(fetchImpl, value);
      attempts.push({ source: "spotify-short-link", loadType: "redirect", count: 1 });
    } catch (error) {
      throw new MusicResolutionError(`Spotify short-link expansion failed: ${error?.message || error}`, {
        code: "SPOTIFY_SHORT_LINK_FAILED",
        userMessage: "That Spotify short link could not be expanded. Try sharing the full Spotify track or episode link.",
        attempts,
      });
    }
  }

  const type = spotifyLinkType(canonicalUrl);
  if (!["track", "episode"].includes(type)) {
    throw new MusicResolutionError("Spotify collection expansion requires Spotify API credentials.", {
      code: "SPOTIFY_COLLECTION_CREDENTIALS_REQUIRED",
      userMessage:
        "Without Spotify API credentials, Stoney Music can resolve individual Spotify tracks and episodes—not full albums or playlists.",
      attempts,
    });
  }

  const endpoint = `https://open.spotify.com/oembed?url=${encodeURIComponent(canonicalUrl)}`;
  let payload;
  try {
    payload = await fetchJson(fetchImpl, endpoint);
    attempts.push({ source: "spotify-oembed", loadType: "metadata", count: payload?.title ? 1 : 0 });
  } catch (error) {
    throw new MusicResolutionError(`Spotify oEmbed lookup failed: ${error?.message || error}`, {
      code: "SPOTIFY_METADATA_FAILED",
      userMessage: "Spotify metadata could not be read right now. Try again shortly.",
      attempts,
    });
  }

  const searchText = [payload?.author_name, payload?.title].filter(Boolean).join(" - ").trim();
  if (!searchText) {
    throw new MusicResolutionError("Spotify oEmbed returned no searchable metadata.", {
      code: "SPOTIFY_METADATA_EMPTY",
      userMessage: "No song information could be read from that Spotify link.",
      attempts,
    });
  }

  const match = await resolveSearchText(resolve, searchText, attempts);
  if (!match) {
    throw new MusicResolutionError("No playable match was found for the Spotify item.", {
      code: "SPOTIFY_NO_PLAYABLE_MATCH",
      userMessage: "The Spotify item was identified, but no playable match was available.",
      attempts,
    });
  }

  return { tracks: [match.track], source: "spotify-oembed", playlistName: null, notices: [] };
}

async function resolveMusicQuery(
  query,
  {
    resolve,
    fetchImpl = globalThis.fetch,
    searchPrefixes = DEFAULT_SEARCH_PREFIXES,
    maxPlaylistTracks = MAX_PLAYLIST_TRACKS,
  } = {}
) {
  if (typeof resolve !== "function") {
    throw new TypeError("resolve must be a function");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const value = String(query || "").trim();
  const attempts = [];
  if (!value) {
    throw new MusicResolutionError("The play query is empty.", {
      code: "EMPTY_QUERY",
      userMessage: "Enter a song name or link.",
      attempts,
    });
  }

  if (isAppleMusicUrl(value)) {
    const result = await resolveAppleMusic(value, { resolve, fetchImpl, attempts });
    return { ...result, attempts };
  }

  if (isSpotifyUrl(value)) {
    const result = await resolveSpotify(value, { resolve, fetchImpl, attempts });
    return { ...result, attempts };
  }

  if (isHttpUrl(value)) {
    const result = await resolveIdentifier(resolve, value, attempts);
    if (result.tracks.length) {
      return {
        tracks: result.tracks.slice(0, maxPlaylistTracks),
        source: "direct",
        playlistName: result.playlistInfo?.name || null,
        notices:
          result.tracks.length > maxPlaylistTracks
            ? [`Only the first ${maxPlaylistTracks} tracks were queued.`]
            : [],
        attempts,
      };
    }

    throw new MusicResolutionError("The direct link returned no playable tracks.", {
      code: result.loadType === "error" ? "DIRECT_LOAD_FAILED" : "DIRECT_EMPTY",
      userMessage:
        "That link did not return playable audio. It may be private, age-restricted, region-blocked, or temporarily blocked by the source.",
      attempts,
    });
  }

  const match = await resolveSearchText(resolve, value, attempts, searchPrefixes);
  if (!match) {
    throw new MusicResolutionError("No configured provider returned a search match.", {
      code: "SEARCH_EMPTY",
      userMessage: "No playable result was found for that search.",
      attempts,
    });
  }

  return { tracks: [match.track], source: match.source, playlistName: null, notices: [], attempts };
}

module.exports = {
  DEFAULT_SEARCH_PREFIXES,
  MAX_METADATA_TRACKS,
  MAX_PLAYLIST_TRACKS,
  MusicResolutionError,
  appleLinkDetails,
  canonicalLoadType,
  hasEncodedTrack,
  isAppleMusicUrl,
  isSpotifyUrl,
  normalizeLoadResult,
  resolveMusicQuery,
  spotifyLinkType,
  toQueueTrack,
};
