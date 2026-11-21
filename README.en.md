# RokBot

**Self-hosted RokBot server with your own models, committed to native official client patching across platforms.**

[简体中文](README.md) · **English** · [AI Agent Deploy Runbook](docs/AGENT_DEPLOY.en.md) · [Patching Workflow](docs/PATCHING_WORKFLOW.en.md) · [Rebranding & Compatibility](docs/REBRAND_COMPAT.md)

<p align="center"><img src="assets/logo/rokbot-icon-256.png" width="128" alt="RokBot logo" /></p>

---

## Overview

RokBot is a self-hosted AI assistant runtime and official native client patching toolkit:

- **Native Clients First (No WebView Wrapper)**: `android/` directly patches the official React Native + Hermes Android `.xapk` / `.apks` / `.apk`, preserving the authentic native interface and interactions. macOS, Windows, iOS and Web clients are likewise generated from official packages.
- **Enhanced Self-Hosted Host**: Based on official Host `2bb5e41`, with Anthropic Messages, OpenAI Responses and OpenAI Chat APIs, per-Bot model routing, reliable context compaction, admin-password pairing, multi-machine local execution, and deterministic default machine pinning (`ROKBOT_DEFAULT_MACHINE_ID`).
- **One-Click Deploy + In-App Config + Self-Hosted Update Feed**: install from prebuilt images in one command, configure models from any client, and ship signed incremental updates for all four client platforms from your own Host.
- **Clean Distribution**: Contains no official binaries, pre-patched APKs/IPAs, or private keys. Every client is assembled locally from verified official packages.

---

## Detailed Comparison with Upstream

"Upstream" means [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) (baseline `3e9fe8c`) and [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus) (referenced through `1.5.1`).

| Area | Upstream | RokBot |
| --- | --- | --- |
| Branding | `grokbot` / ProkBot naming, official icon | Fully rebranded to `rokbot`: `ROKBOT_*` env vars, `x-rokbot-*` headers, `rokbot_*` cookies, `rokbot-local://` links, `RBDELTA1` / `RBD1` delta formats, `ghcr.io/hongfaqiu/rokbot/*` images. Old names are kept only for migration; see [REBRAND_COMPAT.md](docs/REBRAND_COMPAT.md) |
| Logo | Official Grok Bot icon | New **deformed RokBot logo** ([`assets/logo/`](assets/logo/)) rendered to PNG / `.ico` / `.icns` / Android adaptive `mipmap-*` / iOS `AppIcon` / Host admin and Web icons |
| Host baseline | Host `d0a4baa` / Box `9d2ac1b` | Upgraded to official **Host `2bb5e41` + `sand-box-2bb5e41`** (`officekit-ts`, multi-machine local exec, Local CUA, new extension registry), with every byte patch re-ported and tested, plus a non-blocking fix for `starting extension mcp` during model hot-reload |
| Multi-machine routing | With several desktops online, implicit execution could land on any of them | **ExternalShell routing**: implicit execution goes deterministically to `ROKBOT_DEFAULT_MACHINE_ID`; if it is unset while several machines are online the Host fails loudly instead of picking one at random |
| Device dedup | Re-pairing the same device left duplicate entries in the device list | Clients send a stable `clientDeviceId` (Android / iOS / desktop / Web), so re-pairing replaces the old entry instead of adding one |
| Model config | Only in the Host admin console or `.env` | **In-app model config on every client**: `GET/PUT /local/model`, `/local/model/catalog` (list models), `/local/model/test` (live test request), with automatic Host hot reload; clients prompt for setup when the Host reports `needsModel` |
| Client updates | Manual re-download and reinstall | **Signed incremental auto-update on all four platforms**, served by your own Host: Android `RBDELTA1` deltas with certificate pinning; macOS / Windows ECDSA P-256 signed manifests with `RBD1` ASAR deltas; iOS via `itms-services` / AltStore / SideStore / IPA share sheet |
| Deployment | Fetch the official Host bundle and build images locally | Offline builds are still supported, plus `rakazo`-style **one-click prebuilt-image deploy**: [`install-images.sh`](host/release/install-images.sh) + [`docker-compose.images.yml`](host/release/docker-compose.images.yml) generate secrets, sync proxy settings, wait for health checks and print onboarding steps |
| Desktop / Web | Windows `1.1.0`, macOS `0.71.2`, Web UI from `1.1.0` | macOS / Windows / Web upgraded to official **`1.2.3`** with the RokBot icon, in-app model config and auto-update |
| Android | WebView wrapper around the Windows UI | Native official RN `1.16.0` patch: Pairip neutralization, Hermes bytecode patches, Companion DEX, 16KB-aligned Tailcat, native model config and update screens |
| Testing | Per-module unit tests | New opaque-box E2E suite in [`tests/e2e/`](tests/e2e/) (199 Tier 1–4 tests + Tier 5 adversarial hardening), plus live verification on an Android emulator against a local Host |

---

## Repository Layout

| Directory | Description | Current Target Baseline |
| --- | --- | --- |
| [`host/`](host/) | Self-hosted Host runtime, admin console, update server, Docker build, one-click deploy & byte-patch recipes | Host `2bb5e41` / Box `sand-box-2bb5e41` |
| [`android/`](android/) | **Native React Native Android patcher** (Split XAPK merger, Pairip neutralization, Hermes bytecode patches, Companion DEX, 16KB-aligned Tailcat `.so`, native modals) | Official Android `1.16.0` (build `1075`) |
| [`windows/`](windows/) | Windows x64 client patcher & installer | Official Windows `1.2.3` |
| [`mac/`](mac/) | macOS Apple Silicon client patcher | Official macOS `1.2.3` |
| [`ios/`](ios/) | iOS arm64 decrypted IPA patcher (native dylib injection) | Official iOS `1.16.0` (build `23152`) |
| [`web/`](web/) | Browser web client bundler & uploader | UI from Windows `1.2.3` |
| [`assets/logo/`](assets/logo/) | Deformed RokBot logo master SVG and per-platform icons | — |
| [`tests/e2e/`](tests/e2e/) | Opaque-box end-to-end test suite | — |
| [`docs/`](docs/) | Deployment guide, architecture docs, [rebranding compatibility registry](docs/REBRAND_COMPAT.md) and screenshots | — |

---

## One-Click Host Deploy for Beginners

All you need is a Linux or macOS machine with Docker (Compose v2). No clone and no image build required.

```bash
mkdir rokbot && cd rokbot
curl -fsSL https://raw.githubusercontent.com/hongfaqiu/rokbot/main/host/release/install-images.sh -o install-images.sh
bash install-images.sh
```

The script downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` (mode `0600`, random secrets filled in), pulls the images, starts the stack, waits for health checks, and prints the URLs and onboarding steps.

> [!TIP]
> - If the repository is private or already cloned, run `bash install-images.sh --local` inside `host/release/` to use the local files.
> - To generate the config first and edit it: `bash install-images.sh --prepare-only`, edit `.env`, then run `bash install-images.sh` again.
> - Air-gapped hosts: load the images into Docker first, then run `bash install-images.sh --offline`.
> - Behind a proxy or a registry mirror: set `HTTP_PROXY` / `HTTPS_PROXY` in `.env`, or point `ROKBOT_HOST_IMAGE` / `ROKBOT_BOX_IMAGE` at your mirror.

First-time onboarding (the script prints this too):

1. Get the one-time setup key: `docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key`
2. Open `http://127.0.0.1:18080/admin`, enter the setup key and set an admin password.
3. Create a 6-character pairing code on the Devices page, then enter the Host URL and the code in a client (or sign in with the admin password).
4. Configure a model in the client (next section) or on the admin Model page.
5. For LAN or public access, set `ROKBOT_LISTEN_ADDRESS=0.0.0.0` and `ROKBOT_PUBLIC_URL` in `.env`, ideally behind an HTTPS reverse proxy.

Common `.env` options:

| Variable | Default | Description |
| --- | --- | --- |
| `ROKBOT_PUBLIC_PORT` | `18080` | Published port |
| `ROKBOT_LISTEN_ADDRESS` | `127.0.0.1` | Listen address; use `0.0.0.0` for LAN access |
| `ROKBOT_PUBLIC_URL` | empty | Public HTTPS origin (required for iOS OTA installs) |
| `ROKBOT_ALLOW_DEVICE_MODEL_CONFIG` | `1` | Allow clients to change models in-app |
| `ROKBOT_DEFAULT_MACHINE_ID` | empty | Default execution machine when several desktops are attached |
| `ROKBOT_UPDATE_DIR` | `/data/updates` | Storage for the four platforms' update packages |

For AI coding agents (Claude Code, Cursor, Codex, Antigravity, etc.) automating preflight checks, one-click deploy, model setup, and 4-platform update publishing, see [`docs/AGENT_DEPLOY.en.md`](docs/AGENT_DEPLOY.en.md). For offline image builds, backups and separate execution machines, see [`docs/AI-INSTALL.en.md`](docs/AI-INSTALL.en.md) and [`host/README.en.md`](host/README.en.md).

---

## Building the Clients

| Platform | Command | Docs |
| --- | --- | --- |
| Android | `node android/release/patch-android.mjs --input-apk /path/to/grok-bot-1.16.0.xapk --output-apk android/output/rokbot-android-patched.apk --force` | [`android/README.en.md`](android/README.en.md) |
| iOS | `python3 ios/release/patch-ios.py --input /path/to/decrypted.ipa ...` (bring your own decrypted IPA and signing) | [`ios/README.en.md`](ios/README.en.md) |
| macOS / Windows | See each directory; the tools download and verify the official `1.2.3` installers | [`mac/README.en.md`](mac/README.en.md) · [`windows/README.en.md`](windows/README.en.md) |
| Web | Build `web/output/RokBotLocal-web-1.2.3.zip`, then upload it in the admin console | [`web/README.en.md`](web/README.en.md) |

Everything needs only Node.js `>= 20` (iOS also needs Python 3 and signing tools).

---

## In-App Model Config

A fresh Host has no model yet. When a client connects, `GET /local/status` returns `needsModel: true` and the client shows a setup prompt.

1. **Open Model Config**: on Android tap "Model Config" on the connection screen (`ModelsActivity`); on iOS tap "Model Config" on the connected screen (`RBModels`); on macOS / Windows / Web open it from Settings or the onboarding banner.
2. **Add a provider**: pick the API type (`openai` Chat, `openai-responses`, `anthropic`) and enter the Base URL and API key. API keys are write-only: after saving, clients only see "set", and saving with an empty key keeps the stored one.
3. **List models**: "Fetch models" calls `POST /local/model/catalog` to read the upstream `/models` list; you can also set reasoning effort and context window.
4. **Test**: "Test" calls `POST /local/model/test`, which sends one live request (`Reply with OK.`) with that config and reports the latency.
5. **Save and switch**: the Host writes `/data/model.env` and hot-reloads its runtime. Once it returns `reload.status: "applied"` you can start chatting right away, and you can switch the default model at any time.

Permissions: by default only devices paired with the **admin password** can change models. Devices paired with a pairing code can enter the admin password when saving to step up for that request. Operators can turn in-app config off entirely with `ROKBOT_ALLOW_DEVICE_MODEL_CONFIG=0`.

---

## Incremental Updates on Four Platforms

The admin builds, signs and uploads update packages to their own Host. Clients only trust signature-verified packages served by their own Host.

**Admin publishing flow (Admin console → Client Updates)**

1. Build the new client with this repo's patchers. For Android, always reuse the same signing key (`--keystore`), or the update cannot install over the existing app.
2. Open `/admin?view=updates`, pick the platform (Android / iOS / macOS / Windows) and channel, and upload the signed `.apk` / `.ipa` / `.dmg` / `.zip` / `.exe`. Desktop releases can also include `app.asar`.
3. Enter the version and the numeric version (Android `versionCode` / iOS build). The Android certificate SHA-256 is extracted from the APK automatically.
4. Under "Generate delta", pick an older release and the Host builds the delta (Android `RBDELTA1`, desktop `RBD1`).
5. Add release notes and publish. Desktop manifests are signed with the Host's ECDSA P-256 private key; the public key is shown on the same page and embedded in the clients.

**Client behaviour**

| Platform | Where to check | How it updates |
| --- | --- | --- |
| Android | "Check for Updates" on the connection or profile screen | Fetches `/local/updates/android.json`, prefers the `RBDELTA1` delta and rebuilds the full APK locally, verifies SHA-256, package name and signing-certificate fingerprint, then opens the system installer |
| macOS / Windows | Automatic check at launch (auto-update when idle) or manual check in Settings | Verifies the ECDSA P-256 signed manifest, prefers the `RBD1` ASAR delta, and falls back to the full installer |
| iOS | "Check for Updates" on the connected screen (throttled to every 6 hours) | The iOS sandbox forbids self-replacement, so it offers `itms-services://` OTA (needs an HTTPS `ROKBOT_PUBLIC_URL`), an AltStore / SideStore source, or downloading the IPA and sharing it to TrollStore / Sideloadly |

---

## Self-Hosting Adaptation & Patching Workflow

Full technical details for all platforms (Host `2bb5e41` byte-diff recipes, Android `1.16.0` Split XAPK merge / Pairip neutralization / Hermes bytecode patching / Companion DEX injection & signing, macOS & Windows `1.2.3` Electron ASAR recipes, Web `1.2.3` renderer extraction, iOS `1.16.0` `RokBotLocal.dylib` injection, and tracking future official releases) are documented in **[`docs/PATCHING_WORKFLOW.en.md`](docs/PATCHING_WORKFLOW.en.md)**.

---

## Screenshots

All screenshots come from live verification on an Android emulator (`1.16.0` native-patched APK) against a self-hosted Host (`2bb5e41` + `sand-box-2bb5e41`). Accounts, addresses, pairing codes, container IDs, and keys are masked:

| Android Launcher Icon | Android Pairing | Android In-App Model Config | Android Streaming Chat & Sandbox |
| --- | --- | --- | --- |
| <img src="docs/images/rokbot-android-launcher.png" width="210" alt="Android launcher with RokBot icon" /> | <img src="docs/images/rokbot-android-pairing.png" width="210" alt="Android pairing screen" /> | <img src="docs/images/rokbot-android-models.png" width="210" alt="Android in-app model config" /> | <img src="docs/images/rokbot-android-chat.png" width="210" alt="Android streaming chat and sandbox execution" /> |

| Host Admin Overview | Host Admin Model Config | Host Admin 4-Platform Updates |
| --- | --- | --- |
| <img src="docs/images/rokbot-host-admin-overview.png" width="280" alt="Host Admin overview" /> | <img src="docs/images/rokbot-host-admin-model.png" width="280" alt="Host Admin model config" /> | <img src="docs/images/rokbot-host-admin-updates.png" width="280" alt="Host Admin 4-platform updates" /> |

---

## Live Verification Summary

| Check | Result | Notes |
| --- | --- | --- |
| Offline Opaque-Box E2E (`--tier all --repo-check`) | **PASS (199 / 199)** | All Tier 1–4 tests pass, 0 failed, 0 skipped |
| Live Host E2E (`--tier all --mode live --repo-check`) | **PASS (151 / 199, 0 failed)** | 48 harness-only / unmounted-feature tests skipped by design (destructive `/data/model.env` mutations, unuploaded Web bundle, unattached desktop ExternalShell nodes) |
| Android Streaming Chat (Real Provider) | **PASS** | Android emulator paired to the local test Host, verified via `POST /local/model/test` (`962–1205 ms`) and real streaming replies |
| `sand-box-2bb5e41` Sandbox Tool Execution | **PASS** | Prompted `uname -a && pwd` from Android; `sand-box-2bb5e41` executed and returned kernel info and `/workspace` |
| Host → Android `RBDELTA1` Incremental Update | **PASS** | Uploaded & published `1.16.0 -> 1.16.1`, generated `RBDELTA1` (258 B vs 3,376 B full), verified SHA-256 reconstruction, package/cert mismatch guard, and Android `UpdateManager` UI detection |
| Library File CRUD & Sandbox Headers | **PASS** | `/local/files` upload/list/download/delete, `Content-Security-Policy: default-src 'none'; sandbox`, and `>20 MiB` `413` guard all verified |
| Connectors Discovery | **PASS** | `/local/connectors` & `/admin/api/connectors` return built-in `app-builder` (3 tools) |
| ExternalShell Routing (`ROKBOT_DEFAULT_MACHINE_ID`) | **Harness PASS / Live NOT_TESTABLE** | Deterministic routing & `409` guard verified in harness; no physical desktop ExternalShell nodes attached to the test stack |
| Voice (ASR/TTS) & Push (APNs/FCM) | **NOT_TESTABLE (no external credentials)** | `/local/voice/status` and `/admin/api/push` endpoints verified; external Fish/APNs/FCM credentials are not configured on the test stack |

---

## Testing

```bash
# Opaque-box E2E suite (built-in mock Host + repository checks)
node tests/e2e/runner.mjs --tier all --repo-check

# Against a real running Host
ROKBOT_E2E_HOST_URL=http://127.0.0.1:18080 ROKBOT_E2E_ADMIN_PASSWORD=<admin-password> \
  node tests/e2e/runner.mjs --tier all --mode live --repo-check
```

Per-module unit tests are described in each directory's README.

---

## Credits & Upstream References

RokBot builds on ideas, patch mechanisms, and architecture learned from two upstream open-source projects:

1. **[ProkBot](https://gitee.com/ahaduoduoduo/ProkBot)** (baseline `3e9fe8c`) — pioneered containerizing the Host and patching official clients for self-hosting;
2. **[ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus)** (referenced through `1.5.1`) — added multi-provider model APIs, per-Bot routing, reliable compaction, Windows/Web clients, and deployment tooling.

The one-click installer's flow is modelled on `rakazo`. RokBot starts fresh as an independent repository focused on **native official client patching** and advancing to the **latest Host bundle baseline**.

---

## License & Notices

- Licensed under the [ProkBot Noncommercial License 1.0](LICENSE): personal use, study, modification, and noncommercial distribution only; commercial use of any kind is prohibited. See [NOTICE](NOTICE).
- Unofficial project, not affiliated with xAI, Grok Bot, or Cursor/Anysphere. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
