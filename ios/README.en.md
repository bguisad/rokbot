# RokBot iOS Patch

[简体中文](README.md)

Patch a decrypted Grok Bot arm64 IPA: `1.27.0` (`29519`), `1.26.0` (`29388`) or `1.16.0` (`23152`). The app and all three extensions must be decrypted. Requires Python 3.9+. This repository does not provide any original or modified IPA; bring your own.

For the full deployment steps see the [deployment guide](../docs/AI-INSTALL.en.md#client-packages); for how it works see the [technical documentation](../docs/ARCHITECTURE.en.md#ios-client).

## Supported versions

The patch identifies its input by the version, build number and pinned digests of the IPA's `Info.plist` and binaries: `1.27.0 (29519)` is configured in `recipes/ios/manifest.json`, and `1.26.0 (29388)` and `1.16.0 (23152)` in `recipes/ios/<version>/manifest.json`. Other versions are rejected.

- App Store binaries are FairPlay-encrypted and cannot be fetched or decrypted automatically, so you must bring your own decrypted IPA.
- For every version the tool checks the main executable's `__text` digest (`nativeTextSha256`), the Hermes bundle digest (`hbcSha256`) and the digest of the injected `RokBotLocal.dylib` before applying the `.gbp.gz` bytepatches.

## Use

```sh
python3 release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./RokBot-Patched \
  --bundle-id dev.rokbot.local
```

`--output` must be a new directory that does not exist yet. It receives the unsigned `RokBot-Local-resignable.ipa`, `RokBotLocal.dylib` and `patch-report.json`, plus `extension-signing.json` when the extensions are kept. This repository does not provide signed IPAs; use the generated IPA only on your own devices, or have your Host administrator publish it on the Client updates page. See [Getting the clients](../README.en.md#getting-the-clients). Sign and install it with your own tools as described below, then enter your Host address and 6-character pairing code (or switch to **Admin Password** pairing).

Push notifications use APNs or Bark, configured in the Host console. Enable realtime voice in the app settings.

## Signing & Free Apple ID Limits

The patch keeps the Widgets, Share and NotificationService extensions by default. Configure a provisioning profile for each of the four targets:

| Target | Bundle ID |
| --- | --- |
| Main app | Your `--bundle-id` value (default `dev.rokbot.local`) |
| Widgets | `<main ID>.widgets` |
| Share | `<main ID>.share` |
| NotificationService | `<main ID>.NotificationService` |

- **Free 7-day Apple ID (3 App ID limit)**: Free Apple accounts allow at most 3 active App IDs, which cannot cover all 4 targets. Pass `--remove-extensions` to strip extensions and sign only the main app.
- **Paid Apple Developer account (4 targets)**: All four targets share the same App Group (`group.<main ID>` by default, or `--app-group`). The shared keychain group is `<AppIdentifierPrefix>.<main ID>.shared`; add it to the signing entitlements of all four targets, and set each target's Info.plist `SandKeychainAccessGroups` to an array containing it (`extension-signing.json` lists this configuration).
- An app signed with the APNs entitlement uses APNs, with credentials configured in the Host. Otherwise, enter a Bark URL in the app's notification settings.
- **Device deduplication (`clientDeviceId`)**: Re-signing/upgrading with the same `CFBundleIdentifier` or disconnecting and re-pairing preserves `clientDeviceId` in Keychain (`dev.rokbot.local.<bundleId>` / `client-device-id`) and `NSUserDefaults`, preventing duplicate device entries on the Host.

## In-App Model Configuration (`RBModels`)

- On pairing or restored launch, the app queries `GET /local/status`. If `needsModel` is true, a non-blocking onboarding prompt guides you to **Model Config**.
- You can also open **Model Config** anytime from the Connection screen to view, add, edit, or switch providers (`openai`, `openai-responses`, `anthropic`) and profiles, fetch remote model catalogs (`POST /local/model/catalog`), and run live preflight tests (`POST /local/model/test`, 125s timeout).
- Leaving the API Key blank on an existing provider preserves the stored key on the Host. If the device was not paired with an admin password and the Host returns `403`, the app prompts for an admin password held in memory only (`X-RokBot-Admin-Password`) and never persisted to disk.
- **Scenario models and per-Bot routes**: the model page adds Scenario Models (input suggestions, summarization, memory extraction, auto-review, subagents, automations) and Per-Bot Routes. Unset entries follow the default route. Saving always sends `scenarioRoutes` and keeps any existing `adaptiveRouting`, so scenarios set on other clients are not dropped.
- **Pickers**: default profile, effort, fallbacks, API format and provider use the RokBot bottom choice sheet (`RBChoiceSheet`) instead of system action sheets or segmented controls, in light and dark mode and with Dynamic Type.

## Input suggestions (`RBSuggestions`)

- When the chat composer is focused and empty, a bar above it shows your quick phrases first, then up to 4 suggestions the model generated from the conversation. Tapping one sends it right away through `POST /api/sendPrompt`; if sending fails, the text goes into the composer instead.
- Empty chats, or chats where the Host returns no model suggestions, only show quick phrases. There are no preset texts, and failures are not cached.
- Input Suggestions on the connection page turns suggestions and AI suggestions on or off and adds, edits, deletes and reorders quick phrases. Settings live on the Host (`/local/suggestions/settings`, `/local/suggestions/phrases`) and sync with desktop, web and Android.

## New group chat (`RBGroupCreate`)

- The "+" button in the chat list opens a RokBot bottom sheet with New Bot and New Group Chat. The connection page also has a New Group Chat entry.
- The flow matches desktop 1.3.0: one page, recipients picked in a "To:" bar, up to 6 Bots, new Bots created inline by typing a name, the group name generated with the desktop rules (max 72 characters) and an empty description. You can write the first message, and the app opens the new group when it is created. If creation fails, Bots created inline are deleted and the draft and recipients are kept.

## In-App Updates & iOS Sandbox Constraints (`RBUpdater`)

Due to iOS sandboxing and code-signing enforcement, apps **cannot silently overwrite their signed bundle or apply binary delta patches** (and `patch-app.py` disables `Expo.plist` OTA updates so the patched Hermes bundle is never bypassed). **Check for Updates** in the Connection screen (plus a 6-hour-throttled background check) queries `GET /local/updates/ios.json` (`rokbot-ios-update/v1`), compares `version` and `build`, checks `bundleId` compatibility, displays size and SHA-256, and offers:

1. **OTA Install (`itms-services://`)**: Executed by iOS's `itunesstored` daemon outside RokBot's sandbox; requires a trusted **`https://` non-loopback** `manifest.plist` URL (Tailcat `127.0.0.1` loopback URLs cannot be reached by `itunesstored`) and a compatible Ad-Hoc/Enterprise/Developer provisioning profile matching `CFBundleIdentifier`.
2. **AltStore / SideStore (`altstore://`, `sidestore://`)**: Opens AltStore or SideStore with the Host's source feed to re-sign and install using your own Apple credentials.
3. **Download IPA & Share (TrollStore / Sideloadly / Files)**: Streams the `.ipa` over `NSURLSessionDownloadTask` (works over Tailcat and attaches `Bearer` auth only to matching Host origins), verifies byte size and chunked `CC_SHA256` on disk, and opens the iOS Share Sheet for TrollStore, AltStore, Sideloadly, or Files.

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
