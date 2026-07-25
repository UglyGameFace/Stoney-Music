# Stoney Music

A public, multi-server Discord music bot using Discord.js, Shoukaku, and Lavalink.

## Public multi-server architecture

Stoney Music has no hard-coded server, channel, or role IDs.

- One global slash-command set is registered for every server that installs the app.
- Every server gets its own isolated setup record, keyed by that server's Discord guild ID.
- An unconfigured server receives its own setup card with Discord's native channel picker.
- When Stoney Music joins a new server while already online, setup starts for that new server automatically.
- The selected music channel and optional access roles never carry over from another server.
- Old `GUILD_ID` and `MUSIC_TEXT_CHANNEL_ID` hosting variables are not valid public configuration and should be deleted.

During the first migration deployment only, an existing legacy `GUILD_ID` may be used to remove the old guild-only command set. It never determines where new commands or setup panels are registered.

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

Install the app with both `bot` and `applications.commands`.

Stoney Music registers these public commands globally:

- `/setup`
- `/play`
- `/skip`
- `/stop`
- `/queue`
- `/nowplaying`
- `/volume`
- `/loop`
- `/filter`

A server owner or member with **Manage Server** can run `/setup`. If Discord's command picker does not display the commands yet, Stoney Music posts a recovery setup card in that server. The admin chooses the desired commands channel using Discord's native channel picker.

The setup card:

- belongs only to the server where it was posted;
- allows one text or announcement channel to be selected;
- enables no role gate by default;
- saves the selection across restarts;
- replaces obsolete panel versions once;
- rejects stale duplicate cards;
- posts a ready card in the selected channel.

## Environment setup

A physical `.env` file is optional. Local deployments may copy `.env.example` to `.env`; Discloud deployments may use Discloud's native environment-variable panel. Both paths populate `process.env`.

Required:

- `DISCORD_TOKEN`
- `LAVALINK_PASSWORD` — use a long random value

Optional runtime tuning:

- `MUSIC_CONFIG_PATH` — override the per-server configuration file path
- `LAVALINK_VERSION`
- `JAVA_OPTS`
- `LAVALINK_WAIT_TIMEOUT`

Do not configure:

- `GUILD_ID`
- `MUSIC_TEXT_CHANNEL_ID`
- server-specific role IDs or names

Delete those legacy values from Discloud after the migration deployment.

## Expected public startup logs

```text
🌐 Registering 9 public global commands for every server using Stoney Music...
✅ Discord accepted 9 public global commands: /filter, /loop, /nowplaying, /play, /queue, /setup, /skip, /stop, /volume
```

An unconfigured server also receives a line like:

```text
🧰 Posted Stoney Music setup for Server Name (SERVER_ID) in #channel-name (CHANNEL_ID); message=MESSAGE_ID.
```

When the bot joins a new server while online:

```text
🆕 Stoney Music joined Server Name (SERVER_ID); starting per-server setup.
```

## Playback repairs

- Correct Lavalink v4 parsing for direct tracks, searches, playlists, empty results, and load errors.
- Current `youtube-source` clients and plugin version.
- Lavalink 4.2.2 bootstrap for current Discord voice support.
- One canonical search chain: YouTube → YouTube Music → SoundCloud.
- Public Apple/iTunes metadata resolution for Apple Music songs and albums.
- Spotify oEmbed resolution for individual tracks, episodes, and `spotify.link` links.
- Serialized queue transitions so skip, loop, failure, and stale events cannot double-advance.
- Java/Node supervision and cleanup through `src/bootstrap.js`.
- Secret-safe repository and deterministic dependency installation.

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

```bash
cp .env.example .env
# Fill in the token and Lavalink password.
bash start.sh
```

`src/bootstrap.js` downloads the pinned Lavalink JAR if needed, starts Java, waits for port 2333, and only then starts the Discord bot. If either process stops, it cleans up the other.

## Deploy to Discloud

Use Discloud's GitHub integration for normal deployments. The included `discloud.config` installs the locked Node dependencies, Java, FFmpeg, and starts `src/bootstrap.js`.

Keep secrets in Discloud's native environment-variable panel. Do not commit `.env`, `node_modules`, logs, plugin downloads, or a Lavalink JAR.

## YouTube caveats

YouTube actively changes access controls. Current clients solve stale-client failures but do not guarantee that every hosting IP will work forever. OAuth and `poToken` are intentionally disabled by default because they are not universal fixes and can introduce account risk. See `docs/YOUTUBE_TROUBLESHOOTING.md` before changing those settings.
