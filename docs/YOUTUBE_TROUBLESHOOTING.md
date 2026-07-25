# YouTube playback troubleshooting

Stoney Music uses Lavalink 4.2.2 and `youtube-source` 1.18.1. The built-in Lavalink YouTube source stays disabled.

## Normal configuration

The configured clients are current names supported by the plugin:

- `MUSIC`
- `ANDROID_VR`
- `WEB`
- `WEBEMBEDDED`
- `TVHTML5_SIMPLY`

Retired names such as `ANDROID_TESTSUITE`, `TVHTML5EMBEDDED`, and `WEB_EMBEDDED` must not be restored.

## Why client changes are not always enough

YouTube can reject datacenter/hosting IP addresses or require a proof-of-origin token. A different client may help one failure and fail another. Treat these as source-side controls, not as a permanent one-line fix.

## Diagnostic order

1. Confirm Lavalink reports version 4.2.2 and the YouTube plugin reports 1.18.1.
2. Confirm the link is public and playable in the same region.
3. Test a text search, a direct video URL, and a playlist separately.
4. Temporarily set `dev.lavalink.youtube: DEBUG` in `application.yml` and restart.
5. Look for HTTP status, login requirement, cipher, or token messages. Never post full logs containing credentials.
6. Review the current `youtube-source` documentation before enabling OAuth, `poToken`, or a remote cipher service.

## OAuth warning

Do not attach a personal Google account. The plugin maintainers warn that OAuth is not a universal solution and can cause rate limits or account action. Use a disposable account only when the current official instructions specifically require it and you accept that risk.

## poToken warning

A `poToken` applies only to compatible web clients and does not repair every source failure. Tokens expire and must be generated/rotated correctly. Do not paste one into Git history.
