# Stoney Music

A locked-down, single-server Discord music bot using Discord.js, Shoukaku, and Lavalink.

## What was repaired

- Correct Lavalink v4 parsing for direct tracks, searches, playlists, empty results, and load errors.
- Current `youtube-source` clients and plugin version; retired client names were removed.
- Lavalink 4.2.2 bootstrap for current Discord DAVE voice support.
- One canonical search chain: YouTube → YouTube Music → SoundCloud.
- Apple Music song and album links without Apple developer credentials by using public Apple/iTunes metadata, then finding a playable match.
- Individual Spotify track and episode links without Spotify OAuth by using Spotify's official oEmbed metadata, then finding a playable match.
- Queue event serialization so skips, loops, failures, and stale end events cannot double-advance or replay the wrong track.
- Safe process supervision for Lavalink and Node on Discloud.
- Secret-safe repository/deployment files and automated regression tests.

## Supported input

| Input | Support |
|---|---|
| Song/title search | Yes |
| Direct YouTube video | Yes |
| YouTube playlist | Yes, capped at 100 tracks per command |
| SoundCloud link/search fallback | Yes |
| Apple Music song | Yes, metadata mirror |
| Apple Music album | Yes, up to 50 songs; unavailable matches are reported |
| Apple Music playlist | Requires Apple Music API credentials; rejected clearly for now |
| Spotify track or episode | Yes, metadata mirror; full and `spotify.link` mobile links |
| Spotify album or playlist | Requires Spotify API credentials; rejected clearly for now |
| Arbitrary HTTP audio/local files | Disabled intentionally |

Apple Music and Spotify links do not stream protected audio from those services. They supply metadata used to find a playable equivalent through the configured Lavalink providers.

## Environment setup

Copy `.env.example` to `.env` for local use, or configure the same variables in Discloud. Never commit `.env`.

Required:

- `DISCORD_TOKEN`
- `MUSIC_TEXT_CHANNEL_ID`
- `LAVALINK_PASSWORD` — use a long random value

Recommended:

- `GUILD_ID` — registers command updates immediately in the target server
- `ROLE_VERIFIED` — defaults to `Verified`
- `ROLE_RESIDENT` — defaults to `Resident`

Local Lavalink defaults:

- `LAVALINK_HOST=127.0.0.1`
- `LAVALINK_PORT=2333`
- `LAVALINK_SECURE=false`
- `LAVALINK_VERSION=4.2.2`

## Runtime requirements

- Node.js 20 or newer; Node.js 22 LTS is used in CI.
- Java 17 or newer for Lavalink; Java 21 is recommended.

## Validate

```bash
npm ci
npm run validate
```

Optional environment/config doctor:

```bash
node scripts/doctor.js
```

## Run locally

`start.sh` supervises both Lavalink and Node. It downloads the official pinned Lavalink JAR if version 4.2.2 is not already present.

```bash
cp .env.example .env
# Fill in real values.
bash start.sh
```

The first startup also downloads the pinned YouTube source plugin from the official Lavalink Maven repository.

## Deploy to Discloud

The included `discloud.config`:

- installs `tools`, `ffmpeg`, and Java;
- installs the exact dependency tree from `package-lock.json`;
- runs `bash start.sh`;
- allocates 2 GB RAM.

Upload a ZIP containing the project root. Do not include `.env`, `node_modules`, logs, plugin downloads, or a stale Lavalink JAR. Configure secrets in the Discloud environment panel.

## YouTube caveats

YouTube actively changes access controls. Current clients solve stale-client failures but do not guarantee that every hosting IP will work forever. OAuth and `poToken` are intentionally disabled by default because maintainers warn they are not universal fixes and OAuth can put the attached Google account at risk. See `docs/YOUTUBE_TROUBLESHOOTING.md` before changing those settings.
