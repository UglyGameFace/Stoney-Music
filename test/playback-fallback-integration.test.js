"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { GuildPlayer } = require("../src/guild-player");
const { resolvePlaybackFallback } = require("../src/playback-fallback");

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
    title: "Moneybagg Yo - I See Why",
    author: "Moneybagg Yo",
    uri: "https://youtube.com/watch?v=blocked",
    durationMs: 182_000,
    sourceName: "youtube",
    requesterId: "user-1",
    encoded: "youtube-blocked",
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

test("Apple metadata mirrored through blocked YouTube recovers through real SoundCloud resolver", async () => {
  const fake = new FakePlayer();
  const searches = [];
  const player = new GuildPlayer(new FakeShoukaku(fake), "guild", {
    logger: { log() {}, warn() {}, error() {} },
    resolveFallback: (track) =>
      resolvePlaybackFallback(track, {
        resolve: async (identifier) => {
          searches.push(identifier);
          return { loadType: "search", data: [soundCloudCandidate()] };
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

  assert.deepEqual(searches, ["scsearch:Moneybagg Yo - I See Why"]);
  assert.deepEqual(fake.played, ["youtube-blocked", "soundcloud-working"]);
  assert.equal(player.nowPlaying().sourceName, "soundcloud");
  assert.equal(player.nowPlaying().fallbackFrom, "youtube");
  assert.equal(player.nowPlaying().requesterId, "user-1");
});
