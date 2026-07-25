"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPlaybackFallbackQuery,
  cleanDisplayTitle,
  isYoutubeTrack,
  resolvePlaybackFallback,
  scorePlaybackCandidate,
} = require("../src/playback-fallback");

function queueTrack(overrides = {}) {
  return {
    title: "Kodak Black - Closure [Official Music Video]",
    author: "Kodak Black",
    uri: "https://youtu.be/MIvhuTmmVUQ",
    durationMs: 172_000,
    sourceName: "youtube",
    encoded: "youtube-encoded",
    requesterId: "user-123",
    ...overrides,
  };
}

function lavalinkTrack(title, author, length, sourceName = "soundcloud") {
  return {
    encoded: `encoded-${title}`,
    info: {
      title,
      author,
      uri: `https://soundcloud.com/example/${encodeURIComponent(title)}`,
      artworkUrl: "https://example.test/art.jpg",
      length,
      sourceName,
      identifier: title,
      isStream: false,
    },
  };
}

test("fallback query removes video labels without repeating the artist", () => {
  const original = queueTrack();
  assert.equal(cleanDisplayTitle(original.title), "Kodak Black - Closure");
  assert.equal(buildPlaybackFallbackQuery(original), "Kodak Black - Closure");
});

test("YouTube detection supports source metadata and direct URL hosts", () => {
  assert.equal(isYoutubeTrack(queueTrack()), true);
  assert.equal(
    isYoutubeTrack(queueTrack({ sourceName: "unknown", uri: "https://www.youtube.com/watch?v=abc" })),
    true
  );
  assert.equal(
    isYoutubeTrack(queueTrack({ sourceName: "soundcloud", uri: "https://soundcloud.com/a/b" })),
    false
  );
});

test("exact title artist and duration outrank remixes and unrelated edits", async () => {
  const remix = lavalinkTrack("Kodak Black - Closure (Sped Up Remix)", "Random Reposts", 128_000);
  const exact = lavalinkTrack("Kodak Black - Closure", "Kodak Black", 171_500);
  const result = await resolvePlaybackFallback(queueTrack(), {
    resolve: async (identifier) => {
      assert.equal(identifier, "scsearch:Kodak Black - Closure");
      return { loadType: "search", data: [remix, exact] };
    },
  });

  assert.ok(result.track);
  assert.equal(result.track.encoded, exact.encoded);
  assert.equal(result.track.sourceName, "soundcloud");
  assert.equal(result.track.requesterId, "user-123");
  assert.equal(result.track.fallbackAttempted, true);
  assert.equal(result.track.fallbackFrom, "youtube");
  assert.equal(result.track.originalTitle, queueTrack().title);
  assert.ok(result.score > scorePlaybackCandidate(queueTrack(), remix));
});

test("poor matches are rejected rather than playing the wrong song", async () => {
  const result = await resolvePlaybackFallback(queueTrack(), {
    resolve: async () => ({
      loadType: "search",
      data: [lavalinkTrack("Completely Different Song", "Someone Else", 172_000)],
    }),
  });

  assert.equal(result.track, null);
  assert.ok(result.score < 0.46);
  assert.deepEqual(result.attempts, [{ source: "scsearch", loadType: "search", count: 1 }]);
});

test("non-YouTube and previously attempted tracks never launch another search", async () => {
  let calls = 0;
  const resolve = async () => {
    calls += 1;
    return { loadType: "empty", data: {} };
  };

  assert.equal(
    await resolvePlaybackFallback(
      queueTrack({ sourceName: "soundcloud", uri: "https://soundcloud.com/a/b" }),
      { resolve }
    ),
    null
  );
  assert.equal(await resolvePlaybackFallback(queueTrack({ fallbackAttempted: true }), { resolve }), null);
  assert.equal(calls, 0);
});

test("provider exceptions are captured as attempts and do not crash the player", async () => {
  const result = await resolvePlaybackFallback(queueTrack(), {
    resolve: async () => {
      throw new Error("SoundCloud unavailable");
    },
  });

  assert.equal(result.track, null);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].loadType, "exception");
  assert.match(result.attempts[0].message, /SoundCloud unavailable/);
});
