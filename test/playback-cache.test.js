"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { PlaybackMatchCache } = require("../src/playback-cache");

function mirror(overrides = {}) {
  return {
    title: "I See Why",
    author: "Moneybagg Yo",
    uri: "https://soundcloud.com/example/i-see-why",
    artworkUrl: "https://example.test/art.jpg",
    durationMs: 180_000,
    sourceName: "soundcloud",
    identifier: "soundcloud-track-1",
    isStream: false,
    encoded: "encoded-soundcloud-track-1",
    requesterId: "original-user",
    playbackCandidateTitle: "Moneybagg Yo - I See Why",
    playbackCandidateAuthor: "Moneybagg Yo",
    playbackIdentity: {
      title: "I See Why",
      artist: "Moneybagg Yo",
      sourceType: "apple-music",
      durationMs: 180_000,
      durationTrusted: true,
    },
    isFallback: true,
    ...overrides,
  };
}

test("confirmed mirrors persist and reload with the current requester", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-playback-cache-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "cache.json");

  const first = new PlaybackMatchCache({ filePath, logger: { warn() {} } });
  await first.load();
  await first.rememberGood("moneybagg|i see why|180", "soundcloud|track-1", mirror());

  const second = new PlaybackMatchCache({ filePath, logger: { warn() {} } });
  await second.load();
  const cached = second.get("moneybagg|i see why|180", { requesterId: "new-user" });

  assert.equal(cached.encoded, "encoded-soundcloud-track-1");
  assert.equal(cached.requesterId, "new-user");
  assert.equal(cached.playbackIdentity.sourceType, "apple-music");
  assert.equal(cached.fallbackVerified, false);
});

test("a dead candidate evicts the matching proven entry and persists", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-playback-dead-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "cache.json");
  const identityKey = "moneybagg|i see why|180";
  const candidateKey = "soundcloud|track-1";

  const cache = new PlaybackMatchCache({ filePath, logger: { warn() {} } });
  await cache.load();
  await cache.rememberGood(identityKey, candidateKey, mirror());
  await cache.rememberDead(identityKey, candidateKey, "HTTP 404");

  assert.equal(cache.get(identityKey), null);
  assert.equal(cache.isDead(candidateKey), true);

  const reloaded = new PlaybackMatchCache({ filePath, logger: { warn() {} } });
  await reloaded.load();
  assert.equal(reloaded.get(identityKey), null);
  assert.deepEqual(reloaded.deadKeys(), [candidateKey]);
});

test("cache writes never include runtime-only fallback candidate arrays", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stoney-playback-clean-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "cache.json");
  const cache = new PlaybackMatchCache({ filePath, logger: { warn() {} } });
  await cache.load();
  await cache.rememberGood("identity", "candidate", mirror({ fallbackCandidates: [mirror()] }));

  const raw = fs.readFileSync(filePath, "utf8");
  assert.doesNotMatch(raw, /fallbackCandidates/);
  assert.match(raw, /encoded-soundcloud-track-1/);
});
