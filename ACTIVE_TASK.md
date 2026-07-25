# Active Task — Restore Stoney Music playback

## Scope
Restore and harden YouTube playback, tokenless Apple Music song/album resolution, and tokenless Spotify single-link resolution; repair queue lifecycle; sanitize, publish, and validate the project before live deployment.

## Root-cause findings
- The backup bundled Lavalink 4.1.2 and stale YouTube-source 1.16.0 configuration.
- Removed/renamed YouTube client identifiers were configured.
- Lavalink v4 `track`, `search`, and `playlist` load-result shapes were parsed incorrectly, causing valid results to appear empty.
- Apple Music was disabled. Enabling LavaSrc without Apple credentials would not repair it; Apple is a metadata mirror rather than a direct protected-audio source.
- Spotify was configured as though credentials/token infrastructure existed when it did not.
- Track-end reasons were ignored, allowing manual skip to replay under track-loop and allowing failure/end races to double-advance.
- The old shell pipeline tracked `tee` instead of Java and `exec node` bypassed cleanup.
- The backup contained a live `.env` and an obsolete generated Lavalink JAR; neither belongs in Git history.
- The first GitHub run exposed a publish-audit false positive: it inspected the working tree after installation and treated untracked `node_modules/` as committed content.

## Implemented changes
- Added one canonical resolver with correct Lavalink v4 parsing and bounded `ytsearch` → `ytmsearch` → `scsearch` fallback.
- Added public Apple/iTunes metadata resolution for Apple Music songs and albums, with bounded concurrency and clear unsupported-playlist errors.
- Added official Spotify oEmbed resolution for tracks and episodes, including safe expansion of mobile `spotify.link` redirects.
- Upgraded the deployment line to Lavalink 4.2.2, youtube-source 1.18.1, Shoukaku 4.3.0, discord.js 14.26.4, and dotenv 17.4.2.
- Removed the unused LavaSrc plugin/configuration so there is no conflicting second metadata implementation.
- Rebuilt queue transitions around serialized end-reason handling, stale-event rejection, exception recovery, and same-voice-channel controls.
- Replaced the process launcher with actual Java/Node PID supervision and cleanup.
- Added Discord markdown/mention/link sanitization for third-party track metadata.
- Added secret-safe `.gitignore`, `.discloudignore`, `.env.example`, CI, deployment docs, and troubleshooting guidance.
- Changed the publish audit to inspect Git-tracked files, ignoring installed-but-untracked dependencies while still rejecting committed dependencies, environment files, JARs, logs, backups, archives, tokens, and private keys.
- Generated and committed a lockfile from GitHub's real npm installation.
- Changed GitHub CI and Discloud builds to deterministic `npm ci` installs.

## Validation status
- JavaScript syntax check: passed for 16 files.
- Bash syntax check: passed.
- `application.yml`: parsed and semantically checked.
- Local regression/integration suite: 31/31 passed after the final lockfile and audit changes.
- Process-supervision integration test: passed and confirmed Lavalink cleanup after Node exit.
- Exact-value scan against live secrets from the original backup: passed with no matches.
- Generic Discord/GitHub token and private-key pattern scan: passed.
- Duplicate/conflict inspection: one resolver, one guild-player class, one player manager, and one interaction owner.
- Node 22.16.0 and Java 21 local validation environment confirmed.
- discord.js 14.26.4 manifest confirms Node >=18; the configured Node 22 line is compatible.
- Shoukaku source confirms the runtime APIs used by the bot: `getIdealNode`, `joinVoiceChannel`, `rest.resolve`, `playTrack`, `stopTrack`, `setGlobalVolume`, and `setFilters`.
- GitHub Actions run `30146935379`: passed with `npm ci`, 31/31 tests, real Discord.js/Shoukaku imports, and committed-secret/runtime-file checks.

## Cleanup status
- Original backup remains untouched.
- Published tree contains no `.env`, live token, Lavalink JAR, plugins, logs, caches, `node_modules`, or deployment archives.
- Stale Lavalink/LavaSrc configuration and duplicate/obsolete resolver behavior were removed rather than retained as compatibility patches.
- Validation PRs #1 and #2 were closed without merge; their trigger files never entered `main`.

## Publication status
- Sanitized source published to `UglyGameFace/Stoney-Music` on `main`.
- Final validated code/config head before this status-only update: `bc3ace53e3d8e830078c273c5c89dedbe89587b0`.
- Deterministic dependency lock committed at `66eed491ec33b0382b7ad16148ddcba33fccf37b`.
- The repository is currently public. No secrets were published, but the originally intended visibility was private.

## Remaining external gates
- Change repository visibility to private if the source should not remain public; the connected GitHub integration cannot change visibility.
- Deploy the current `main` tree to Discloud with the required environment variables.
- Run a controlled live smoke test for text search, direct YouTube playback, YouTube playlists, Apple Music song/album matching, Spotify track/mobile-link matching, skip/loop behavior, failure recovery, and process cleanup.

## Backlog
- Full Spotify album/playlist expansion after valid Spotify application credentials become available.
- Apple Music playlist expansion after valid Apple Music API credentials become available.
- Optional OAuth, poToken, or remote cipher only if live hosting-IP diagnostics prove they are needed; none should be enabled blindly.
