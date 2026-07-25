"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateInitialCandidate,
  refineInitialResolution,
  selectStrictInitialCandidate,
} = require("../src/initial-track-selector");
const { MusicResolutionError, attachTrackIdentity } = require("../src/resolver");

function lavalinkTrack(
  title,
  author,
  {
    sourceName = "youtube",
    identifier = title,
    length = 180_000,
    uri = `https://example.test/${encodeURIComponent(title)}`,
  } = {}
) {
  return {
    encoded: `encoded-${sourceName}-${identifier}`,
    info: {
      title,
      author,
      sourceName,
      identifier,
      length,
      uri,
      artworkUrl: "https://provider.test/art.jpg",
      isStream: false,
    },
  };
}

function catalogIdentity(track, sourceType = "apple-music", overrides = {}) {
  attachTrackIdentity(track, {
    title: "I See Why",
    artist: "Moneybagg Yo",
    album: "Hard to Love",
    artworkUrl: "https://catalog.test/art.jpg",
    durationMs: 181_000,
    durationTrusted: sourceType === "apple-music",
    sourceType,
    sourceId: "catalog-123",
    sourceUrl:
      sourceType === "spotify"
        ? "https://open.spotify.com/track/abc"
        : "https://music.apple.com/us/song/i-see-why/123",
    requestedQuery: "Moneybagg Yo - I See Why",
    ...overrides,
  });
  return track;
}

test("manual search rejects the first remix and selects the exact original", async () => {
  const first = lavalinkTrack("I See Why (Sped Up Remix)", "Moneybagg Yo", {
    identifier: "remix",
  });
  const exact = lavalinkTrack("Moneybagg Yo - I See Why", "Moneybagg Yo", {
    sourceName: "soundcloud",
    identifier: "exact",
    length: 181_000,
  });
  const calls = [];

  const refined = await refineInitialResolution(
    {
      tracks: [first],
      source: "ytsearch",
      notices: [],
      attempts: [],
    },
    "Moneybagg Yo - I See Why",
    {
      resolve: async (identifier) => {
        calls.push(identifier);
        return identifier.startsWith("scsearch:")
          ? { loadType: "search", data: [exact] }
          : { loadType: "search", data: [first] };
      },
    }
  );

  assert.equal(refined.tracks.length, 1);
  assert.equal(refined.tracks[0].encoded, exact.encoded);
  assert.equal(refined.tracks[0].stoneyIdentity.title, "I See Why");
  assert.equal(refined.tracks[0].stoneyIdentity.artist, "Moneybagg Yo");
  assert.ok(calls.includes("scsearch:Moneybagg Yo - I See Why"));
});

test("Apple catalog identity rejects a cover and preserves Apple metadata on the exact result", async () => {
  const cover = catalogIdentity(
    lavalinkTrack("I See Why (Cover)", "Somebody Else", { identifier: "cover" })
  );
  const exact = lavalinkTrack("Moneybagg Yo - I See Why", "Moneybagg Yo", {
    sourceName: "bandcamp",
    identifier: "exact-apple",
    length: 181_200,
  });

  const refined = await refineInitialResolution(
    {
      tracks: [cover],
      source: "apple-music-metadata",
      notices: [],
      attempts: [],
    },
    "https://music.apple.com/us/song/i-see-why/123",
    {
      resolve: async (identifier) =>
        identifier.startsWith("bcsearch:")
          ? { loadType: "search", data: [exact] }
          : { loadType: "search", data: [cover] },
    }
  );

  const identity = refined.tracks[0].stoneyIdentity;
  assert.equal(refined.tracks[0].encoded, exact.encoded);
  assert.equal(identity.sourceType, "apple-music");
  assert.equal(identity.title, "I See Why");
  assert.equal(identity.artist, "Moneybagg Yo");
  assert.equal(identity.artworkUrl, "https://catalog.test/art.jpg");
  assert.equal(identity.durationMs, 181_000);
});

test("Spotify identity uses the same strict initial selector", async () => {
  const remix = catalogIdentity(
    lavalinkTrack("I See Why (Remix)", "Moneybagg Yo", { identifier: "spotify-remix" }),
    "spotify",
    { durationTrusted: false }
  );
  const exact = lavalinkTrack("I See Why", "Moneybagg Yo", {
    sourceName: "soundcloud",
    identifier: "spotify-exact",
    length: 182_000,
  });

  const refined = await refineInitialResolution(
    {
      tracks: [remix],
      source: "spotify-oembed",
      notices: [],
      attempts: [],
    },
    "https://open.spotify.com/track/abc",
    {
      resolve: async (identifier) =>
        identifier.startsWith("scsearch:")
          ? { loadType: "search", data: [exact] }
          : { loadType: "search", data: [remix] },
    }
  );

  assert.equal(refined.tracks[0].encoded, exact.encoded);
  assert.equal(refined.tracks[0].stoneyIdentity.sourceType, "spotify");
  assert.equal(refined.tracks[0].stoneyIdentity.sourceUrl, "https://open.spotify.com/track/abc");
});

test("explicitly requested alternate versions remain allowed", () => {
  const live = lavalinkTrack("I See Why (Live)", "Moneybagg Yo", { identifier: "live" });
  const identity = {
    title: "I See Why (Live)",
    artist: "Moneybagg Yo",
    durationMs: 180_000,
    durationTrusted: false,
    sourceType: "manual-search",
    requestedQuery: "Moneybagg Yo - I See Why (Live)",
  };

  assert.equal(evaluateInitialCandidate(identity, live).accepted, true);
  assert.equal(selectStrictInitialCandidate([live], identity).track, live);
});

test("direct links are preserved exactly and do not launch replacement searches", async () => {
  const direct = lavalinkTrack("Requested Remix", "Requested Artist", {
    identifier: "direct-remix",
    uri: "https://youtu.be/direct-remix",
  });
  let calls = 0;
  const result = {
    tracks: [direct],
    source: "direct",
    playlistName: null,
    notices: [],
    attempts: [],
  };

  const refined = await refineInitialResolution(result, "https://youtu.be/direct-remix", {
    resolve: async () => {
      calls += 1;
      return { loadType: "empty", data: {} };
    },
  });

  assert.equal(refined, result);
  assert.equal(refined.tracks[0], direct);
  assert.equal(calls, 0);
});

test("a correct first result causes no additional provider searches", async () => {
  const exact = lavalinkTrack("Moneybagg Yo - I See Why", "Moneybagg Yo", {
    identifier: "already-exact",
    length: 181_000,
  });
  let calls = 0;
  const refined = await refineInitialResolution(
    {
      tracks: [exact],
      source: "ytsearch",
      notices: [],
      attempts: [],
    },
    "Moneybagg Yo - I See Why",
    {
      resolve: async () => {
        calls += 1;
        return { loadType: "empty", data: {} };
      },
    }
  );

  assert.equal(refined.tracks[0], exact);
  assert.equal(calls, 0);
});

test("only mismatched versions returns a clear strict-match error", async () => {
  const remix = lavalinkTrack("I See Why (Remix)", "Moneybagg Yo", {
    identifier: "only-remix",
  });

  await assert.rejects(
    refineInitialResolution(
      {
        tracks: [remix],
        source: "ytsearch",
        notices: [],
        attempts: [],
      },
      "Moneybagg Yo - I See Why",
      {
        resolve: async () => ({ loadType: "search", data: [remix] }),
      }
    ),
    (error) =>
      error instanceof MusicResolutionError &&
      error.code === "STRICT_MATCH_EMPTY" &&
      /covers, remixes, live versions/i.test(error.userMessage)
  );
});
