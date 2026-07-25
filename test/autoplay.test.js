"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canonicalTrackKey,
  clearAutoplayCaches,
  flattenRadioEntries,
  isUnwantedVersion,
  resolveAutoplayRecommendation,
} = require("../src/autoplay");

function queueTrack(title, author = "Seed Artist", overrides = {}) {
  return {
    title,
    author,
    durationMs: 180_000,
    sourceName: "youtube",
    identifier: `id-${title}`,
    uri: `https://example.com/${encodeURIComponent(title)}`,
    encoded: `encoded-${title}`,
    requesterId: "user-1",
    ...overrides,
  };
}

function rawTrack(title, author, overrides = {}) {
  return {
    encoded: overrides.encoded || `raw-${author}-${title}`,
    info: {
      title,
      author,
      length: overrides.length || 180_000,
      sourceName: overrides.sourceName || "soundcloud",
      identifier: overrides.identifier || `raw-id-${author}-${title}`,
      uri: overrides.uri || `https://soundcloud.com/example/${encodeURIComponent(title)}`,
      isStream: false,
      artworkUrl: "",
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

test.beforeEach(() => clearAutoplayCaches());

test("canonical identity ignores display noise but keeps artist and title", () => {
  assert.equal(
    canonicalTrackKey(queueTrack("Song Name [Official Music Video]", "Artist Name")),
    "artist name::song name"
  );
});

test("radio payloads are flattened and duplicate recording MBIDs are removed", () => {
  const entries = flattenRadioEntries({
    seed: [
      { recording_mbid: "one", similar_artist_name: "A", total_listen_count: 10 },
      { recording_mbid: "one", similar_artist_name: "A", total_listen_count: 10 },
    ],
    related: {
      tracks: [{ recording_mbid: "two", similar_artist_name: "B", total_listen_count: 20 }],
    },
  });
  assert.deepEqual(entries.map((entry) => entry.recordingMbid), ["one", "two"]);
});

test("autoplay uses ListenBrainz radio and never repeats the requested track", async () => {
  const seed = queueTrack("Seed Song", "Seed Artist");
  const requestedUrls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    requestedUrls.push(parsed.toString());
    if (parsed.hostname === "api.listenbrainz.org" && parsed.pathname.includes("/lb-radio/artist/")) {
      return jsonResponse({
        radio: [
          {
            recording_mbid: "seed-recording",
            similar_artist_name: "Seed Artist",
            total_listen_count: 900_000,
          },
          {
            recording_mbid: "related-recording",
            similar_artist_name: "Related Artist",
            total_listen_count: 700_000,
          },
        ],
      });
    }
    if (parsed.hostname === "musicbrainz.org" && parsed.pathname.includes("/artist/")) {
      return jsonResponse({ artists: [{ id: "artist-mbid", name: "Seed Artist", score: 100 }] });
    }
    if (parsed.hostname === "musicbrainz.org" && parsed.pathname.includes("/recording/")) {
      return jsonResponse({
        recordings: [
          {
            id: "seed-recording",
            title: "Seed Song",
            length: 180_000,
            "artist-credit": [{ name: "Seed Artist" }],
          },
          {
            id: "related-recording",
            title: "Related Song",
            length: 184_000,
            "artist-credit": [{ name: "Related Artist" }],
          },
        ],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const resolve = async (identifier) => {
    if (identifier === "scsearch:Related Artist - Related Song") {
      return {
        loadType: "search",
        data: [rawTrack("Related Song", "Related Artist", { length: 184_000 })],
      };
    }
    return { loadType: "empty", data: {} };
  };

  const result = await resolveAutoplayRecommendation(seed, {
    resolve,
    fetchImpl,
    history: [seed],
    random: () => 0,
    logger: { warn() {} },
  });

  assert.equal(result.recommendationProvider, "listenbrainz-radio");
  assert.equal(result.track.title, "Related Song");
  assert.equal(result.track.author, "Related Artist");
  assert.equal(result.track.autoplay, true);
  assert.equal(result.track.autoplaySeedTitle, "Seed Song");
  assert.equal(result.track.recordingMbid, "related-recording");
  assert.equal(requestedUrls.some((url) => url.includes("lb-radio/artist/artist-mbid")), true);
});

test("autoplay rejects covers and altered versions that were not requested", () => {
  const seed = queueTrack("Original Song", "Artist");
  assert.equal(isUnwantedVersion(seed, { title: "Original Song (Remix)" }), true);
  assert.equal(isUnwantedVersion(seed, { title: "Original Song Karaoke" }), true);
  assert.equal(isUnwantedVersion(seed, { title: "Original Song" }), false);
  assert.equal(
    isUnwantedVersion(queueTrack("Original Song Remix", "Artist"), { title: "Original Song Remix" }),
    false
  );
});

test("provider-search fallback still finds another same-artist song when radio APIs fail", async () => {
  const seed = queueTrack("Seed Song", "Seed Artist");
  const fetchImpl = async () => {
    throw new Error("radio unavailable");
  };
  const resolve = async (identifier) => {
    if (identifier === "scsearch:Seed Artist") {
      return {
        loadType: "search",
        data: [
          rawTrack("Seed Song", "Seed Artist"),
          rawTrack("Different Song", "Seed Artist", { length: 195_000 }),
          rawTrack("Different Song (Slowed + Reverb)", "Seed Artist", { length: 230_000 }),
        ],
      };
    }
    return { loadType: "empty", data: {} };
  };

  const result = await resolveAutoplayRecommendation(seed, {
    resolve,
    fetchImpl,
    history: [seed],
    random: () => 0,
    logger: { warn() {} },
  });

  assert.equal(result.recommendationProvider, "provider-search");
  assert.equal(result.track.title, "Different Song");
  assert.equal(result.track.autoplay, true);
});

test("autoplay returns no recommendation instead of replaying exhausted history", async () => {
  const seed = queueTrack("Seed Song", "Seed Artist");
  const different = queueTrack("Different Song", "Seed Artist", {
    identifier: "raw-id-Seed Artist-Different Song",
    uri: "https://soundcloud.com/example/Different%20Song",
  });
  const result = await resolveAutoplayRecommendation(seed, {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    resolve: async (identifier) => {
      if (identifier === "scsearch:Seed Artist") {
        return {
          loadType: "search",
          data: [rawTrack("Seed Song", "Seed Artist"), rawTrack("Different Song", "Seed Artist")],
        };
      }
      return { loadType: "empty", data: {} };
    },
    history: [seed, different],
    random: () => 0,
    logger: { warn() {} },
  });
  assert.equal(result?.track || null, null);
});
