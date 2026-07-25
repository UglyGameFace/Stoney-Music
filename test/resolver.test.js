"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MusicResolutionError,
  appleLinkDetails,
  normalizeLoadResult,
  resolveMusicQuery,
  spotifyLinkType,
  toQueueTrack,
} = require("../src/resolver");

function lavalinkTrack(name, sourceName = "youtube") {
  return {
    encoded: `encoded-${name}`,
    info: {
      title: name,
      author: "Artist",
      uri: `https://example.test/${encodeURIComponent(name)}`,
      sourceName,
      identifier: name,
      length: 123_000,
      isStream: false,
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

test("normalizes every Lavalink v4 load-result shape", () => {
  const track = lavalinkTrack("one");
  assert.deepEqual(normalizeLoadResult({ loadType: "track", data: track }).tracks, [track]);
  assert.deepEqual(normalizeLoadResult({ loadType: "search", data: [track] }).tracks, [track]);
  assert.deepEqual(
    normalizeLoadResult({ loadType: "playlist", data: { info: { name: "mix" }, tracks: [track] } }),
    { loadType: "playlist", tracks: [track], playlistInfo: { name: "mix" }, error: null }
  );
  assert.deepEqual(normalizeLoadResult({ loadType: "empty", data: {} }).tracks, []);
  assert.equal(normalizeLoadResult({ loadType: "error", data: { message: "blocked" } }).error.message, "blocked");
});

test("filters malformed tracks and accepts legacy encoded field", () => {
  const validLegacy = { track: "legacy", info: { title: "Legacy" } };
  const result = normalizeLoadResult({ loadType: "search", data: [{ info: {} }, validLegacy] });
  assert.deepEqual(result.tracks, [validLegacy]);
  assert.equal(toQueueTrack(validLegacy, "user").encoded, "legacy");
});

test("search falls back from YouTube to YouTube Music before SoundCloud", async () => {
  const calls = [];
  const result = await resolveMusicQuery("Artist Song", {
    resolve: async (identifier) => {
      calls.push(identifier);
      if (identifier.startsWith("ytmsearch:")) {
        return { loadType: "search", data: [lavalinkTrack("match")] };
      }
      return { loadType: "empty", data: {} };
    },
  });

  assert.deepEqual(calls, ["ytsearch:Artist Song", "ytmsearch:Artist Song"]);
  assert.equal(result.source, "ytmsearch");
  assert.equal(result.tracks[0].info.title, "match");
});

test("direct playlists preserve all valid tracks and playlist metadata", async () => {
  const result = await resolveMusicQuery("https://youtube.com/playlist?list=abc", {
    resolve: async () => ({
      loadType: "playlist",
      data: { info: { name: "My playlist" }, tracks: [lavalinkTrack("a"), lavalinkTrack("b")] },
    }),
  });

  assert.equal(result.playlistName, "My playlist");
  assert.deepEqual(result.tracks.map((track) => track.info.title), ["a", "b"]);
});

test("Apple selected-song album links resolve through the public iTunes lookup API", async () => {
  const fetchCalls = [];
  const result = await resolveMusicQuery(
    "https://music.apple.com/us/album/example/123456?i=987654",
    {
      fetchImpl: async (url) => {
        fetchCalls.push(url);
        return jsonResponse({
          resultCount: 1,
          results: [
            {
              wrapperType: "track",
              kind: "song",
              trackName: "Apple Song",
              artistName: "Apple Artist",
              collectionName: "Apple Album",
            },
          ],
        });
      },
      resolve: async (identifier) => ({
        loadType: "search",
        data: [lavalinkTrack(identifier)],
      }),
    }
  );

  assert.match(fetchCalls[0], /itunes\.apple\.com\/lookup/);
  assert.match(fetchCalls[0], /id=987654/);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.source, "apple-music-metadata");
});

test("Apple album links resolve multiple songs and report skipped matches", async () => {
  const result = await resolveMusicQuery("https://music.apple.com/us/album/example/123456", {
    fetchImpl: async () =>
      jsonResponse({
        resultCount: 3,
        results: [
          { wrapperType: "collection", collectionName: "Album" },
          {
            wrapperType: "track",
            trackName: "One",
            artistName: "Artist",
            collectionName: "Album",
          },
          {
            wrapperType: "track",
            trackName: "Two",
            artistName: "Artist",
            collectionName: "Album",
          },
        ],
      }),
    resolve: async (identifier) => {
      if (identifier.includes("Two")) return { loadType: "empty", data: {} };
      return { loadType: "search", data: [lavalinkTrack("One")] };
    },
  });

  assert.equal(result.playlistName, "Album");
  assert.equal(result.tracks.length, 1);
  assert.deepEqual(result.notices, ["Skipped 1 song(s) with no playable match."]);
});

test("Apple playlists fail clearly instead of pretending credentials exist", async () => {
  await assert.rejects(
    resolveMusicQuery("https://music.apple.com/us/playlist/example/pl.abc", {
      resolve: async () => ({ loadType: "empty", data: {} }),
    }),
    (error) =>
      error instanceof MusicResolutionError &&
      error.code === "APPLE_PLAYLIST_CREDENTIALS_REQUIRED" &&
      /credentials/i.test(error.userMessage)
  );
});

test("Spotify track links use official oEmbed metadata then source search", async () => {
  const calls = [];
  const result = await resolveMusicQuery("https://open.spotify.com/track/abc", {
    fetchImpl: async (url) => {
      calls.push(url);
      return jsonResponse({ title: "Spotify Song", author_name: "Spotify Artist" });
    },
    resolve: async (identifier) => ({
      loadType: "search",
      data: [lavalinkTrack(identifier)],
    }),
  });

  assert.match(calls[0], /open\.spotify\.com\/oembed/);
  assert.equal(result.source, "spotify-oembed");
  assert.match(result.tracks[0].info.title, /Spotify Artist - Spotify Song/);
});

test("Spotify albums and playlists fail clearly without API credentials", async () => {
  for (const type of ["album", "playlist"]) {
    await assert.rejects(
      resolveMusicQuery(`https://open.spotify.com/${type}/abc`, {
        resolve: async () => ({ loadType: "empty", data: {} }),
      }),
      (error) => error.code === "SPOTIFY_COLLECTION_CREDENTIALS_REQUIRED"
    );
  }
});

test("link parsers recognize storefront and international path variants", () => {
  assert.deepEqual(appleLinkDetails("https://music.apple.com/gb/song/example/123"), {
    type: "song",
    id: "123",
    storefront: "gb",
  });
  assert.equal(spotifyLinkType("https://open.spotify.com/intl-de/track/abc"), "track");
});

test("Spotify mobile short links expand before official oEmbed lookup", async () => {
  const calls = [];
  const result = await resolveMusicQuery("https://spotify.link/short-code", {
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith("https://spotify.link/")) {
        return {
          ok: true,
          status: 200,
          url: "https://open.spotify.com/track/expanded123",
        };
      }
      return jsonResponse({ title: "Expanded Song", author_name: "Expanded Artist" });
    },
    resolve: async (identifier) => ({
      loadType: "search",
      data: [lavalinkTrack(identifier)],
    }),
  });

  assert.equal(calls[0], "https://spotify.link/short-code");
  assert.match(calls[1], /open\.spotify\.com\/oembed/);
  assert.match(decodeURIComponent(calls[1]), /open\.spotify\.com\/track\/expanded123/);
  assert.equal(result.source, "spotify-oembed");
});

test("Spotify short links reject redirects outside Spotify", async () => {
  await assert.rejects(
    resolveMusicQuery("https://spotify.link/bad", {
      fetchImpl: async () => ({ ok: true, status: 200, url: "https://example.com/not-spotify" }),
      resolve: async () => ({ loadType: "empty", data: {} }),
    }),
    (error) => error.code === "SPOTIFY_SHORT_LINK_FAILED"
  );
});
