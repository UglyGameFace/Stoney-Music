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
- The original shell pipeline tracked `tee` instead of Java and `exec node` bypassed cleanup.
- The backup contained a live `.env` and an obsolete generated Lavalink JAR; neither belongs in Git history.
- The first GitHub run exposed a publish-audit false positive: it inspected the working tree after installation and treated untracked `node_modules/` as committed content.
- The first live Discloud boot launched `src/index.js` as PID 1 and never executed `start.sh`; therefore Lavalink was never started and Shoukaku received `ECONNREFUSED 127.0.0.1:2333`.
- The Discord entrypoint loaded the same `/home/node/.env` twice through duplicate candidate paths and still used the deprecated `ready` event name.
- Discord accepted all nine guild commands for the correct live server, but the Android client still did not display them after reinstall, cache clearing, and full owner permissions.
- Old `Verified` and `Resident` role defaults were server-specific leftovers and must not be assumed for the current server.

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
- Replaced the deployment entrypoint with `src/bootstrap.js` and set it as Discloud `MAIN`, npm start, and the `start.sh` delegate, so Java/Lavalink startup cannot be bypassed by Discloud choosing the main file directly.
- Added one idempotent environment loader and migrated Discord startup to `Events.ClientReady`.
- Added readiness timeout and partial-startup cleanup coverage, including termination of Lavalink when the bot exits or readiness never succeeds.
- Added persistent `/setup` configuration and automatic single-server guild-command registration.
- Added a slash-command-independent recovery setup card with an admin button for clients that do not display registered commands.
- Removed all default role-name assumptions; setup enables no role gate unless roles are explicitly selected.
- Confirmed that Discloud native environment variables are supported without a physical `.env` file.

## Validation status
- JavaScript syntax check: passed for 25 files after the recovery-panel merge.
- Bash syntax check: passed.
- `application.yml`: parsed and semantically checked.
- Local regression/integration suite: 35/35 passed after the Discloud bootstrap repair.
- Process-supervision integration tests: passed and confirmed Lavalink cleanup after bot exit and after readiness timeout.
- Exact-value scan against live secrets from the original backup: passed with no matches.
- Generic Discord/GitHub token and private-key pattern scan: passed.
- Duplicate/conflict inspection: one resolver, one guild-player class, one player manager, and one interaction owner.
- Node 22.16.0 and Java 21 local validation environment confirmed.
- discord.js 14.26.4 manifest confirms Node >=18; the configured Node 22 line is compatible.
- Shoukaku source confirms the runtime APIs used by the bot: `getIdealNode`, `joinVoiceChannel`, `rest.resolve`, `playTrack`, `stopTrack`, `setGlobalVolume`, and `setFilters`.
- GitHub Actions run `30146935379`: passed with `npm ci`, 31/31 tests, real Discord.js/Shoukaku imports, and committed-secret/runtime-file checks.
- Bootstrap repair GitHub Actions run `30147546280`: passed on the implementation head with locked `npm ci`, 35/35 tests, runtime imports, and secret/runtime-file checks.
- Exact final PR-head GitHub Actions run `30147578549`: passed with locked `npm ci`, 35/35 tests, runtime imports, and secret/runtime-file checks.
- Persistent setup PR #5 passed GitHub Actions and was squash-merged as `7944d7babbc625ac7c28a0b5b8100c7d745e739c`.
- Recovery-panel PR #6 passed GitHub Actions run `30150720854` with locked dependency installation, full validation, runtime imports, and publish-safety checks; it was squash-merged as `5d0cfdf3ede541490e89e18c5938dfad646921e2`.

## Cleanup status
- Original backup remains untouched.
- Published tree contains no `.env`, live token, Lavalink JAR, plugins, logs, caches, `node_modules`, or deployment archives.
- Stale Lavalink/LavaSrc configuration and duplicate/obsolete resolver behavior were removed rather than retained as compatibility patches.
- Validation PRs #1 and #2 were closed without merge; their trigger files never entered `main`.
- Startup repair PR #3, setup PR #5, and recovery-panel PR #6 were squash-merged after hosted validation.

## Publication status
- Sanitized source is published to `UglyGameFace/Stoney-Music` on `main`.
- Deterministic dependency lock is committed.
- Current production baseline on `main` is `5d0cfdf3ede541490e89e18c5938dfad646921e2` plus this status-only record update.
- The repository is currently public. No secrets were published, but the originally intended visibility was private.

## Remaining external gates
- Redeploy the current `main` tree to Discloud while preserving native environment variables.
- Press the posted **Set Up In This Channel** recovery button and confirm the saved channel has no role gate.
- Run controlled live tests for text search, direct YouTube playback, YouTube playlists, Apple Music song/album matching, Spotify track/mobile-link matching, skip/loop behavior, failure recovery, and process cleanup.

## Backlog
- Full Spotify album/playlist expansion after valid Spotify application credentials become available.
- Apple Music playlist expansion after valid Apple Music API credentials become available.
- Optional OAuth, poToken, or remote cipher only if live hosting-IP diagnostics prove they are needed; none should be enabled blindly.
