"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PlayerManager,
  candidateLevelRetryTrack,
  filterUnrequestedFastFallback,
  filterUnrequestedFastResolution,
  requestAllowsFastVersion,
} = require("../src/player");
const { playbackCandidateKey } = require("../src/playback-fallback");

function queueTrack(overrides = {}) {
  return {
    title: "I See Why",
    author: "MoneyBagg Yo",
    durationMs: 185_000,
    requesterId: "user-1",
    sourceName: "youtube",
    identifier: "failed-video",
    uri: "https://youtube.com/watch?v=failed-video",
    encoded: "failed-youtube-encoded",
    requestedQuery: "moneybagg yo i see why",
    playbackIdentity: {
      title: "I See Why",
      artist: "MoneyBagg Yo",
      durationMs: 185_000,
      durationTrusted: true,
      requestedQuery: "moneybagg yo i see why",
      sourceType: "manual-search",
    },
    fallbackTriedKeys: [],
    ...overrides,
  };
}

function lavalinkTrack({
  title = "MoneyBagg Yo - I See Why",
  author = "MoneyBagg Yo",
  encoded = "alternate-youtube-encoded",
  identifier = "alternate-video",
  sourceName = "youtube",
  length = 185_000,
} = {}) {
  return {
    encoded,
    info: {
      title,
      author,
      identifier,
      uri: `https://example.test/${identifier}`,
      artworkUrl: "https://example.test/art.jpg",
      length,
      sourceName,
      isStream: false,
    },
  };
}

test("a failed upload does not blacklist its entire provider", async () => {
  const failed = queueTrack();
  const calls = [];
  const manager = Object.create(PlayerManager.prototype);
  manager.playbackCacheReady = Promise.resolve();
  manager.playbackCache = {
    get: () => null,
    deadKeys: () => [],
  };
  manager.resolve = async (identifier) => {
    calls.push(identifier);
    return {
      loadType: "search",
      data: [
        lavalinkTrack({
          encoded: failed.encoded,
          identifier: failed.identifier,
        }),
        lavalinkTrack(),
      ],
    };
  };

  const result = await manager.resolveFallback(failed, {
    prefixes: ["ytmsearch", "ytsearch"],
    triedKeys: [playbackCandidateKey(failed)],
  });

  assert.deepEqual(calls, [
    "ytmsearch:MoneyBagg Yo - I See Why",
    "ytsearch:MoneyBagg Yo - I See Why",
  ]);
  assert.ok(result.track);
  assert.equal(result.track.encoded, "alternate-youtube-encoded");
  assert.equal(result.attempts.some((entry) => entry.loadType === "skipped-same-provider"), false);
});

test("candidate retry preserves the original provider only as history", () => {
  const retried = candidateLevelRetryTrack(queueTrack());
  assert.equal(retried.sourceName, "failed-candidate");
  assert.equal(retried.fallbackFrom, "youtube");
  assert.equal(retried.playbackIdentity.title, "I See Why");
});

test("fast and sped-up versions are rejected unless explicitly requested", () => {
  const fast = {
    ...queueTrack(),
    playbackCandidateTitle: "MoneyBagg Yo - I See Why (Fast)",
    fallbackSource: "scsearch",
    fallbackScore: 0.99,
  };
  const normal = {
    ...queueTrack({ encoded: "normal" }),
    playbackCandidateTitle: "MoneyBagg Yo - I See Why",
    fallbackSource: "scsearch",
    fallbackScore: 0.98,
  };

  const filtered = filterUnrequestedFastFallback(queueTrack(), {
    track: fast,
    candidates: [fast, normal],
    source: "scsearch",
    score: 0.99,
    rejections: [],
  });

  assert.equal(filtered.candidates.length, 1);
  assert.equal(filtered.track.encoded, "normal");
  assert.match(JSON.stringify(filtered.rejections), /alternate-version:fast/);
  assert.equal(requestAllowsFastVersion("moneybagg yo i see why fast", fast), true);
  assert.equal(requestAllowsFastVersion("moneybagg yo i see why sped up", fast), true);
});

test("an initial fast-only result fails clearly when fast was not requested", () => {
  const fast = {
    ...queueTrack(),
    title: "I See Why (Fast)",
    playbackCandidateTitle: "MoneyBagg Yo - I See Why (Fast)",
  };

  assert.throws(
    () =>
      filterUnrequestedFastResolution(
        { source: "search", tracks: [fast], attempts: [], notices: [] },
        "moneybagg yo i see why"
      ),
    (error) => error?.code === "FAST_VERSION_ONLY"
  );

  const allowed = filterUnrequestedFastResolution(
    { source: "search", tracks: [fast], attempts: [], notices: [] },
    "moneybagg yo i see why fast"
  );
  assert.equal(allowed.tracks.length, 1);
});

test("a direct fast-version URL remains intentional", () => {
  const fast = {
    ...queueTrack(),
    title: "I See Why (Fast)",
    playbackCandidateTitle: "I See Why (Fast)",
  };
  const result = filterUnrequestedFastResolution(
    { source: "direct", tracks: [fast], attempts: [], notices: [] },
    "https://soundcloud.com/example/i-see-why-fast"
  );
  assert.equal(result.tracks.length, 1);
});
