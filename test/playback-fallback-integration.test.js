"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { resolvePlaybackFallback } = require("../src/playback-fallback");
const { ResilientGuildPlayer } = require("../src/resilient-guild-player");

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.volumes = [];
  }

  async playTrack(payload) {
    this.played.push(payload.track.encoded);
  }

  async setGlobalVolume(volume) {
    this.volumes.push(volume);
  }

  async stopTrack() {}
}

class FakeShoukaku {
  constructor(player) {
    this.player = player;
  }

  async joinVoiceChannel() {
    return this.player;
  }
}

function youtubeMirror() {
  return {
    title: "I See Why",
    author: "Moneybagg Yo",
    uri: "https://youtube.com/watch?v=blocked",
    durationMs: 182_000,
    sourceName: "youtube",
    identifier: "blocked",
    requesterId: "user-1",
    encoded: "youtube-blocked",
    playbackCandidateTitle: "Moneybagg Yo - I See Why",
    playbackCandidateAuthor: "Moneybagg Yo",
    playbackIdentity: {
      title: "I See Why",
      artist: "Moneybagg Yo",
      album: "Hard to Love",
      artworkUrl: "https://apple.test/art.jpg",
      durationMs: 182_000,
      durationTrusted: true,
      sourceType: "apple-music",
      sourceId: "apple-track-1",
      sourceUrl: "https://music.apple.com/us/song/i-see-why/1",
      requestedQuery: "Moneybagg Yo - I See Why",
    },
    fallbackTriedKeys: [],
    fallbackAttemptCount: 0,
  };
}

function soundCloudCandidate() {
  return {
    encoded: "soundcloud-working",
    info: {
      title: "Moneybagg Yo - I See Why",
      author: "Moneybagg Yo",
      uri: "https://soundcloud.com/example/i-see-why",
      artworkUrl: "",
      length: 181_600,
      sourceName: "soundcloud",
      identifier: "i-see-why",
      isStream: false,
    },
  };
}

test("Apple metadata mirrored through blocked YouTube builds a real multi-provider recovery plan", async () => {
  const fake = new FakePlayer();
  const searches = [];
  const player = new ResilientGuildPlayer(new FakeShoukaku(fake), "guild", {
    logger: { log() {}, warn() {}, error() {} },
    resolveFallback: (track, options) =>
      resolvePlaybackFallback(track, {
        ...options,
        resolve: async (identifier) => {
          searches.push(identifier);
          if (identifier.startsWith("scsearch:")) {
            return { loadType: "search", data: [soundCloudCandidate()] };
          }
          return { loadType: "empty", data: {} };
        },
      }),
  });

  await player.connect({ guildId: "guild", voiceChannelId: "voice", shardId: 0 });
  const original = youtubeMirror();
  player.enqueue(original);
  await player.playNext();

  await player._handleTrackException({
    track: { encoded: original.encoded },
    exception: { message: "All clients failed: sign in to confirm you're not a bot" },
  });

  assert.deepEqual(searches, [
    "scsearch:Moneybagg Yo - I See Why",
    "bcsearch:Moneybagg Yo - I See Why",
  ]);
  assert.deepEqual(fake.played, ["youtube-blocked", "soundcloud-working"]);
  assert.equal(player.nowPlaying().sourceName, "soundcloud");
  assert.equal(player.nowPlaying().fallbackFrom, "youtube");
  assert.equal(player.nowPlaying().requesterId, "user-1");
  assert.equal(player.nowPlaying().title, "I See Why");
  assert.equal(player.nowPlaying().author, "Moneybagg Yo");
  assert.equal(player.nowPlaying().artworkUrl, "https://apple.test/art.jpg");
  assert.equal(player.nowPlaying().playbackIdentity.sourceType, "apple-music");
});
