"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPlaybackFallbackQuery,
  cleanDisplayTitle,
  evaluatePlaybackCandidate,
  fallbackIdentityKey,
  isYoutubeTrack,
  playbackCandidateKey,
  resolvePlaybackFallback,
  scorePlaybackCandidate,
  unexpectedVersionMarkers,
} = require("../src/playback-fallback");

function queueTrack(overrides = {}) {
  return {
    title: "Closure",
    author: "Kodak Black",
    uri: "https://youtu.be/MIvhuTmmVUQ",
    durationMs: 172_000,
    sourceName: "youtube",
    identifier: "MIvhuTmmVUQ",
    encoded: "youtube-encoded",
    requesterId: "user-123",
    playbackIdentity: {
      title: "Closure",
      artist: "Kodak Black",
      album: "Closure",
      artworkUrl: "https://example.test/apple-art.jpg",
      durationMs: 172_000,
      durationTrusted: true,
      sourceType: "apple-music",
      sourceId: "apple-123",
      sourceUrl: "https://music.apple.com/us/song/closure/123",
      requestedQuery: "Kodak Black - Closure",
    },
    fallbackTriedKeys: [],
    fallbackAttemptCount: 0,
    ...overrides,
  };
}

function lavalinkTrack(title, author, length, sourceName = "soundcloud", suffix = "1") {
  return {
    encoded: `encoded-${sourceName}-${suffix}-${title}`,
    info: {
      title,
      author,
      uri: `https://${sourceName}.example/${suffix}/${encodeURIComponent(title)}`,
      artworkUrl: "https://example.test/provider-art.jpg",
      length,
      sourceName,
      identifier: `${sourceName}-${suffix}`,
      isStream: false,
    },
  };
}

test("fallback query uses the preserved request identity", () => {
  const original = queueTrack({ title: "Wrong YouTube Display Title" });
  assert.equal(cleanDisplayTitle("Closure [Official Music Video]"), "Closure");
  assert.equal(buildPlaybackFallbackQuery(original), "Kodak Black - Closure");
  assert.match(fallbackIdentityKey(original), /kodak black\|closure/);
});

test("YouTube detection supports source metadata and direct URL hosts", () => {
  assert.equal(isYoutubeTrack(queueTrack()), true);
  assert.equal(
    isYoutubeTrack(queueTrack({ sourceName: "unknown", uri: "https://www.youtube.com/watch?v=abc" })),
    false
  );
  assert.equal(
    isYoutubeTrack(queueTrack({ sourceName: "soundcloud", uri: "https://soundcloud.com/a/b" })),
    false
  );
});

test("exact title artist and duration outrank remixes and preserve Apple identity", async () => {
  const remix = lavalinkTrack("Closure (Sped Up Remix)", "Random Reposts", 128_000, "soundcloud", "remix");
  const exact = lavalinkTrack("Kodak Black - Closure", "Kodak Black", 171_500, "soundcloud", "exact");
  const result = await resolvePlaybackFallback(queueTrack(), {
    prefixes: ["scsearch"],
    resolve: async (identifier) => {
      assert.equal(identifier, "scsearch:Kodak Black - Closure");
      return { loadType: "search", data: [remix, exact] };
    },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.track.encoded, exact.encoded);
  assert.equal(result.track.title, "Closure");
  assert.equal(result.track.author, "Kodak Black");
  assert.equal(result.track.artworkUrl, "https://example.test/apple-art.jpg");
  assert.equal(result.track.playbackCandidateTitle, "Kodak Black - Closure");
  assert.equal(result.track.sourceName, "soundcloud");
  assert.equal(result.track.requesterId, "user-123");
  assert.equal(result.track.isFallback, true);
  assert.ok(result.score > scorePlaybackCandidate(queueTrack(), remix));
  assert.match(JSON.stringify(result.rejections), /alternate-version/);
});

test("hard version markers reject covers remixes live edits and karaoke", () => {
  for (const marker of ["Remix", "Cover", "Live", "Karaoke", "Slowed + Reverb", "Nightcore"]) {
    const candidate = lavalinkTrack(`Closure (${marker})`, "Kodak Black", 172_000);
    const evaluation = evaluatePlaybackCandidate(queueTrack(), candidate);
    assert.equal(evaluation.accepted, false, marker);
    assert.ok(unexpectedVersionMarkers("Closure", candidate.info.title).length > 0, marker);
  }
});

test("the requested version may explicitly allow its matching marker", () => {
  const original = queueTrack({
    playbackIdentity: {
      ...queueTrack().playbackIdentity,
      title: "Closure (Live)",
    },
    title: "Closure (Live)",
  });
  const candidate = lavalinkTrack("Closure (Live)", "Kodak Black", 172_000);
  assert.equal(evaluatePlaybackCandidate(original, candidate).accepted, true);
});

test("poor artist title or duration matches are rejected rather than guessed", async () => {
  const result = await resolvePlaybackFallback(queueTrack(), {
    prefixes: ["scsearch"],
    resolve: async () => ({
      loadType: "search",
      data: [
        lavalinkTrack("Closure", "Completely Different Artist", 172_000, "soundcloud", "wrong-artist"),
        lavalinkTrack("Completely Different Song", "Kodak Black", 172_000, "soundcloud", "wrong-title"),
        lavalinkTrack("Closure", "Kodak Black", 92_000, "soundcloud", "wrong-duration"),
      ],
    }),
  });

  assert.equal(result.track, null);
  assert.equal(result.candidates.length, 0);
  assert.equal(result.rejections.length, 3);
});

test("multiple strict candidates are retained for sequential stream retries", async () => {
  const first = lavalinkTrack("Closure", "Kodak Black", 171_800, "soundcloud", "first");
  const second = lavalinkTrack("Kodak Black - Closure", "Kodak Black", 172_200, "bandcamp", "second");
  const result = await resolvePlaybackFallback(queueTrack(), {
    prefixes: ["scsearch", "bcsearch"],
    resolve: async (identifier) => ({
      loadType: "search",
      data: identifier.startsWith("scsearch:") ? [first] : [second],
    }),
  });

  assert.equal(result.candidates.length, 2);
  assert.deepEqual(
    new Set(result.candidates.map((track) => track.sourceName)),
    new Set(["soundcloud", "bandcamp"])
  );
});

test("a SoundCloud 404 may recover through other providers instead of stopping", async () => {
  const original = queueTrack({
    sourceName: "soundcloud",
    identifier: "dead-soundcloud",
    uri: "https://soundcloud.com/dead/closure",
    encoded: "dead-soundcloud-encoded",
  });
  const calls = [];
  const bandcamp = lavalinkTrack("Closure", "Kodak Black", 172_000, "bandcamp", "working");
  const result = await resolvePlaybackFallback(original, {
    prefixes: ["scsearch", "bcsearch"],
    resolve: async (identifier) => {
      calls.push(identifier);
      return { loadType: "search", data: [bandcamp] };
    },
  });

  assert.deepEqual(calls, ["bcsearch:Kodak Black - Closure"]);
  assert.equal(result.track.sourceName, "bandcamp");
  assert.equal(result.attempts[0].loadType, "skipped-same-provider");
});

test("tried and dead candidates are excluded from a new plan", async () => {
  const first = lavalinkTrack("Closure", "Kodak Black", 172_000, "soundcloud", "dead");
  const second = lavalinkTrack("Closure", "Kodak Black", 172_000, "soundcloud", "good");
  const firstKey = playbackCandidateKey({
    sourceName: first.info.sourceName,
    identifier: first.info.identifier,
    uri: first.info.uri,
    encoded: first.encoded,
  });
  const result = await resolvePlaybackFallback(queueTrack(), {
    prefixes: ["scsearch"],
    deadKeys: [firstKey],
    resolve: async () => ({ loadType: "search", data: [first, second] }),
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.track.encoded, second.encoded);
});

test("a cached proven candidate is preferred but fresh backups are still retained", async () => {
  const cached = {
    ...queueTrack({
      sourceName: "bandcamp",
      identifier: "cached",
      uri: "https://bandcamp.example/cached",
      encoded: "cached-encoded",
    }),
    isFallback: true,
  };
  const fresh = lavalinkTrack("Closure", "Kodak Black", 172_000, "soundcloud", "fresh");
  const result = await resolvePlaybackFallback(queueTrack(), {
    prefixes: ["scsearch"],
    cachedCandidates: [cached],
    resolve: async () => ({ loadType: "search", data: [fresh] }),
  });

  assert.equal(result.candidates[0].encoded, "cached-encoded");
  assert.equal(result.candidates.length, 2);
});

test("provider exceptions are recorded and do not crash plan creation", async () => {
  const result = await resolvePlaybackFallback(queueTrack(), {
    prefixes: ["scsearch"],
    resolve: async () => {
      throw new Error("SoundCloud unavailable");
    },
  });

  assert.equal(result.track, null);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].loadType, "exception");
  assert.match(result.attempts[0].message, /SoundCloud unavailable/);
});
