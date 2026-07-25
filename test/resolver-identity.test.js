"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveMusicQuery, toQueueTrack } = require("../src/resolver");

function lavalinkTrack({
  title = "Provider Title",
  author = "Provider Artist",
  sourceName = "youtube",
  identifier = "provider-id",
  uri = "https://youtube.com/watch?v=provider-id",
  length = 180_000,
} = {}) {
  return {
    encoded: `encoded-${sourceName}-${identifier}`,
    info: {
      title,
      author,
      sourceName,
      identifier,
      uri,
      length,
      artworkUrl: "https://provider.test/art.jpg",
      isStream: false,
    },
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

test("Apple links preserve Apple title artist artwork duration and track ID", async () => {
  const result = await resolveMusicQuery(
    "https://music.apple.com/us/album/i-see-why/123?i=456",
    {
      fetchImpl: async () =>
        jsonResponse({
          resultCount: 1,
          results: [
            {
              wrapperType: "track",
              trackId: 456,
              trackName: "I See Why",
              artistName: "Moneybagg Yo",
              collectionName: "Hard to Love",
              artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/example/100x100bb.jpg",
              trackViewUrl: "https://music.apple.com/us/song/i-see-why/456",
              trackTimeMillis: 181_234,
            },
          ],
        }),
      resolve: async () => ({
        loadType: "search",
        data: [
          lavalinkTrack({
            title: "Moneybagg Yo - I See Why (Official Video)",
            author: "Moneybagg Yo",
            length: 181_000,
          }),
        ],
      }),
    }
  );
  const queued = toQueueTrack(result.tracks[0], "user");

  assert.equal(queued.title, "I See Why");
  assert.equal(queued.author, "Moneybagg Yo");
  assert.equal(queued.durationMs, 181_234);
  assert.match(queued.artworkUrl, /1200x1200bb/);
  assert.equal(queued.playbackIdentity.album, "Hard to Love");
  assert.equal(queued.playbackIdentity.sourceType, "apple-music");
  assert.equal(queued.playbackIdentity.sourceId, "456");
  assert.equal(queued.playbackCandidateTitle, "Moneybagg Yo - I See Why (Official Video)");
});

test("Spotify links preserve Spotify oEmbed identity while provider audio remains separate", async () => {
  const result = await resolveMusicQuery("https://open.spotify.com/track/abc", {
    fetchImpl: async () =>
      jsonResponse({
        title: "Spotify Catalog Song",
        author_name: "Spotify Catalog Artist",
        thumbnail_url: "https://spotify.test/art.jpg",
      }),
    resolve: async () => ({
      loadType: "search",
      data: [
        lavalinkTrack({
          title: "Spotify Catalog Artist - Spotify Catalog Song",
          author: "Spotify Catalog Artist",
          sourceName: "youtube",
        }),
      ],
    }),
  });
  const queued = toQueueTrack(result.tracks[0], "user");

  assert.equal(queued.title, "Spotify Catalog Song");
  assert.equal(queued.author, "Spotify Catalog Artist");
  assert.equal(queued.artworkUrl, "https://spotify.test/art.jpg");
  assert.equal(queued.playbackIdentity.sourceType, "spotify");
  assert.equal(queued.playbackIdentity.sourceUrl, "https://open.spotify.com/track/abc");
});

test("manual artist-title searches preserve what the user actually requested", async () => {
  const result = await resolveMusicQuery("Moneybagg Yo - I See Why", {
    resolve: async () => ({
      loadType: "search",
      data: [
        lavalinkTrack({
          title: "Moneybagg Yo - I See Why (Official Video)",
          author: "Moneybagg Yo",
        }),
      ],
    }),
  });
  const queued = toQueueTrack(result.tracks[0], "user");

  assert.equal(queued.title, "I See Why");
  assert.equal(queued.author, "Moneybagg Yo");
  assert.equal(queued.requestedQuery, "Moneybagg Yo - I See Why");
  assert.equal(queued.playbackIdentity.sourceType, "manual-search");
});

test("direct YouTube links retain resolved metadata as the fallback identity", async () => {
  const direct = lavalinkTrack({
    title: "Kodak Black - Closure [Official Music Video]",
    author: "Kodak Black",
    identifier: "MIvhuTmmVUQ",
    uri: "https://youtu.be/MIvhuTmmVUQ",
    length: 172_000,
  });
  const result = await resolveMusicQuery("https://youtu.be/MIvhuTmmVUQ", {
    resolve: async () => ({ loadType: "track", data: direct }),
  });
  const queued = toQueueTrack(result.tracks[0], "user");

  assert.equal(queued.playbackIdentity.sourceType, "direct-link");
  assert.equal(queued.playbackIdentity.sourceUrl, "https://youtu.be/MIvhuTmmVUQ");
  assert.equal(queued.playbackIdentity.sourceId, "MIvhuTmmVUQ");
  assert.equal(queued.playbackCandidateTitle, "Kodak Black - Closure [Official Music Video]");
});
