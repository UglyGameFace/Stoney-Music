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
- A JavaScript bootstrap that Discloud runs as its actual `MAIN`; it starts Lavalink, waits for readiness, then starts and supervises the Discord bot.
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

## First-time server setup

After installing the app to the server with both `bot` and `applications.commands`, restart the bot. On a one-server deployment, Stoney Music automatically registers guild commands even when `GUILD_ID` is omitted.

Run `/setup` as a server admin. It defaults the music command channel to the channel where the command is used and auto-detects `Verified` and `Resident` roles when those roles exist. Optional channel and role selections can be supplied directly in the command. The saved setup is reused after restarts.

The bot must appear under **Server Settings → Integrations → Bots and Apps** before any slash command can appear.

## Environment setup

Copy `.env.example` to `.env` for local use, or configure the same variables in Discloud. Never commit `.env`.

Required:

- `DISCORD_TOKEN`
- `LAVALINK_PASSWORD` — use a long random value

Optional:

- `GUILD_ID` — the bot auto-detects its server when connected to exactly one
- `MUSIC_TEXT_CHANNEL_ID` — legacy/default channel; `/setup` replaces it with the saved selection
- `ROLE_VERIFIED` — defaults to `Verified`
- `ROLE_RESIDENT` — defaults to `Resident`

## Slash commands

The bot registers `/setup` plus the music commands:

- `/setup` — admin-only first-time configuration
- `/play`
- `/skip`
- `/stop`
- `/queue`
- `/nowplaying`
- `/volume`
- `/loop`
- `/filter`

For the fastest and clearest registration, set `GUILD_ID` to the exact server where the bot is installed. A healthy startup logs the target server and the full accepted command list:

```text
🧭 Registering 9 guild commands for Server Name (SERVER_ID)...
✅ Discord accepted 9 guild commands for Server Name (SERVER_ID): /filter, /loop, /nowplaying, /play, /queue, /setup, /skip, /stop, /volume
```

On a one-server deployment, a missing or stale `GUILD_ID` is recovered automatically from the connected server. Multi-server deployments still require an exact `GUILD_ID` for immediate guild commands.

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

`src/bootstrap.js` is the canonical launcher used by Discloud, npm, and `start.sh`. It downloads the official pinned Lavalink JAR if needed, starts Java, waits until port 2333 is accepting connections, and only then starts the Discord bot. If either process stops, it cleans up the other so Discloud can restart the whole service safely.

```bash
cp .env.example .env
# Fill in real values.
bash start.sh
```

The first startup also downloads the pinned YouTube source plugin from the official Lavalink Maven repository.

## Deploy to Discloud

The included `discloud.config`:

- installs `tools`, `ffmpeg`, and Java;
- installs the locked Node dependencies with `npm ci`;
- sets `MAIN=src/bootstrap.js`, so startup remains correct even if Discloud ignores a custom `START` command;
- allocates 2 GB RAM.

Upload a ZIP containing the project root. Do not include `.env`, `node_modules`, logs, plugin downloads, or a stale Lavalink JAR. Configure secrets in the Discloud environment panel.

### Expected startup order

A healthy Discloud boot should show this order before Discord login:

1. one environment-file message;
2. Java version detection;
3. Lavalink download or installed-version confirmation;
4. `Starting Lavalink`;
5. `Lavalink is accepting connections`;
6. `Starting Stoney Music bot`;
7. Discord login and slash-command registration.

Seeing `(node:1)` immediately followed by `ECONNREFUSED 127.0.0.1:2333` means an old deployment is still launching `src/index.js` directly instead of the bootstrap. Redeploy the current project root so Discloud reads the updated `discloud.config`.

## YouTube caveats

YouTube actively changes access controls. Current clients solve stale-client failures but do not guarantee that every hosting IP will work forever. OAuth and `poToken` are intentionally disabled by default because maintainers warn they are not universal fixes and OAuth can put the attached Google account at risk. See `docs/YOUTUBE_TROUBLESHOOTING.md` before changing those settings.
