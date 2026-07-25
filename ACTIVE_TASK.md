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

## Validation status
- JavaScript syntax check: passed for 15 files.
- Bash syntax check: passed.
- `application.yml`: parsed and semantically checked.
- Regression/integration suite: 28/28 passed, including a final rerun after publication.
- Process-supervision integration test: passed and confirmed Lavalink cleanup after Node exit.
- Exact-value scan against live secrets from the original backup: passed with no matches.
- Generic Discord/GitHub token and private-key pattern scan: passed.
- Duplicate/conflict inspection: one resolver, one guild-player class, one player manager, and one interaction owner.
- Node 22.16.0 and Java 21 local validation environment confirmed.
- discord.js 14.26.4 manifest confirms Node >=18; the configured Node 22 line is compatible.
- Shoukaku source confirms the runtime APIs used by the bot: `getIdealNode`, `joinVoiceChannel`, `rest.resolve`, `playTrack`, `stopTrack`, `setGlobalVolume`, and `setFilters`.
- Live Discord/Discloud playback smoke testing remains required because this environment has no bot token or voice connection.

## Cleanup status
- Original backup remains untouched.
- Published tree contains no `.env`, live token, Lavalink JAR, plugins, logs, caches, `node_modules`, or deployment archives.
- Stale Lavalink/LavaSrc configuration and duplicate/obsolete resolver behavior were removed rather than retained as compatibility patches.

## Publication status
- Sanitized source published to `UglyGameFace/Stoney-Music` on `main`.
- Runtime baseline commit: `beb55b124bd3915327dbeb37a613989d26795a41`.
- Validation-only draft PR: `#1`, branch `agent/validate-published-baseline`.
- The repository is currently public. No secrets were published, but the intended repository visibility was private.

## Current blockers
- GitHub created no Actions check suite or workflow run after PR `opened`, branch `synchronize`, and PR `reopened` events. This points to repository/account Actions settings rather than a test failure—the workflow never began `npm install`.
- The connected GitHub integration can publish source, branches, commits, and pull requests, but it cannot change repository visibility or enable repository Actions.
- Real dependency installation therefore remains unverified in GitHub-hosted CI.

## Remaining external gates
- Enable GitHub Actions for this repository and rerun draft PR #1; do not merge its `VALIDATION_TRIGGER.md` file.
- Change repository visibility to private if the source should not be public.
- A controlled Discloud smoke test must verify text search, direct YouTube playback, YouTube playlists, Apple Music song/album matching, Spotify track/mobile-link matching, skip/loop behavior, failure recovery, and process cleanup.

## Backlog
- Full Spotify album/playlist expansion after valid Spotify application credentials become available.
- Apple Music playlist expansion after valid Apple Music API credentials become available.
- Optional OAuth, poToken, or remote cipher only if live hosting-IP diagnostics prove they are needed; none should be enabled blindly.
