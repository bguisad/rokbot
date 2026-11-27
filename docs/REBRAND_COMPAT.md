# Rebranding & Compatibility Registry (`docs/REBRAND_COMPAT.md`)

[简体中文部署手册](AI-INSTALL.md) · [English Deployment Guide](AI-INSTALL.en.md) · [架构文档](ARCHITECTURE.md) · [Architecture (EN)](ARCHITECTURE.en.md)

This document is the authoritative registry for RokBot's `grokbot` / `prokbot` → `rokbot` rebranding boundary. It separates **Category A** (project-owned identifiers that are fully rebranded to `rokbot` and `https://github.com/hongfaqiu/rokbot`), **Category B** (upstream-pinned constants that **must remain intact** for binary patching and runtime protocol compatibility), **Migration & Staged Bridges** (bounded backwards-compatibility shims), and **Historical Attribution Exemptions**.

---

## 1. Classification Policy

| Category | Definition | Rule |
| --- | --- | --- |
| **Category A (Project-Owned)** | RokBot repository URLs, container/image names, Compose project names, `ROKBOT_*` env vars, `x-rokbot-*` HTTP headers, `rokbot_*` cookies, output bundle/package IDs, URL schemes, delta schemas, local directories, UI copy, and docs | **100% rebranded** to `rokbot` / `RokBot` / `hongfaqiu/rokbot` |
| **Category B (Upstream-Constrained)** | Official binary filenames inside vendor archives, bundle/package IDs checked prior to patching, compiled Hermes/Electron/Swift RPC & IPC channel names, protobuf enum literals, official cloud/CDN/store URLs, and official `sand-host` / `SAND_*` runtime hooks | **Preserved as-is** in validators, byte-patch anchors, and protocol interceptors |
| **Migration & Staged Bridges** | Explicitly bounded fallback logic for upgrading existing `.env` deployments, legacy delta headers, binary JNI ABI compatibility layers, or staged M1.3.2 / M1.4 transitions | **Strictly scoped & documented** here so audits do not confuse them with unaddressed leaks |
| **Historical Attribution** | Project license (`RokBot Noncommercial License 1.0`), retained upstream license (`ProkBot Noncommercial License 1.0` in `LICENSES/`), upstream credits, and trademark disclaimers | **Preserved** in `NOTICE` and `README*.md` Credits |

### Category A Summary Mapping

| Surface | Legacy (`grokbot` / `prokbot`) | Target (`rokbot`) |
| --- | --- | --- |
| Repository & Releases | `https://github.com/ferretgeek/prokbot-plus` | `https://github.com/hongfaqiu/rokbot` |
| Container Images | `grokbot-host:local`, `grokbot-box-input:*` | `rokbot-host:local`, `rokbot-box-input:*`, `ghcr.io/hongfaqiu/rokbot/{host,box}` |
| Compose Project / Dirs | `grokbot`, `~/grokbot`, `/opt/grokbot`, `~/.grokbot-local` | `rokbot`, `~/rokbot`, `/opt/rokbot`, `~/.rokbot-local` |
| Environment Variables | `GROKBOT_*`, `PROKBOT_*` | `ROKBOT_*` (`ROKBOT_PORT`, `ROKBOT_BIND`, `ROKBOT_PUBLIC_URL`, `ROKBOT_DEFAULT_MACHINE_ID`, `ROKBOT_HOST_IMAGE`, `ROKBOT_BOX_IMAGE`, `ROKBOT_DOWNLOAD_BASE`, `ROKBOT_HOST_ARCHIVE_URL`, `ROKBOT_DESKTOP_DOWNLOAD_BASE`, `ROKBOT_ALLOW_DEVICE_MODEL_CONFIG`, `ROKBOT_UPDATE_DIR`, etc.) |
| Cookies & Headers | `grokbot_admin`, `grokbot_web`, `grokbot_vnc_*`, `x-grokbot-*` | `rokbot_admin`, `rokbot_web`, `rokbot_vnc_${slot}`, `x-rokbot-csrf`, `x-rokbot-web`, `x-rokbot-foreground`, `x-rokbot-tailcat-ingress`, `x-rokbot-telemetry-blocked`, `x-rokbot-event-id`, `x-rokbot-timestamp`, `x-rokbot-signature`, `x-rokbot-signature-256`, `x-rokbot-admin-password` |
| Package IDs & Schemes | `dev.grokbot.nativeapp`, `dev.grokbot.local`, `grokbot-local://` | `dev.rokbot.nativeapp`, `dev.rokbot.local`, `rokbot-local://` |
| Schemas, App Kind & Provider Key | `grokbot-*-update/v1`, `grokbot-web-bundle/v1`, `grokbot-app`, `providerOptions.grokbot` | `rokbot-*-update/v1`, `rokbot-web-bundle/v1`, `rokbot-app`, `providerOptions.rokbot` |
| Delta Formats & Archives | `GBDELTA1` (`.gbdelta`), `GBD1`, `prokbot-host-src.tar.gz` | `RBDELTA1` (`.rbdelta`), `RBD1`, `rokbot-host-src.tar.gz` |

---

## 2. Category-B Upstream-Constrained Identifiers (Preserved)

### 2.1 Official Package, Bundle & Input Binary Identities

| Identifier | Verified Locations | Technical Reason Preserved |
| --- | --- | --- |
| `ai.x.grok.bot` | `android/recipes/manifest.json:3,5`, `android/release/patch-android.mjs:2,579`, `android/patchers/dex.mjs` (`dexContainsClass`), `android/patchers/manifest.mjs:480`, `android/companion/src/main/java/dev/rokbot/nativeapp/{RokBotApplication,PairipVmBridge,R8OkHttpHook,R8OkHttpInterceptor}.java`, `android/companion/compile-stubs/src/main/java/ai/x/grok/bot/MainApplication.java:1`, `android/test-target/AndroidManifest.xml:3`, `ci/test_release_packages.py:73`, `ci/test_verify_release.py:39` | Official Google Play Android package ID and compiled DEX class namespace inside `grok-bot-1.26.0.xapk`. Output APKs rewrite `packageName` to `dev.rokbot.nativeapp` via `--package-name` (`manifest.mjs` expands relative `.MainActivity` to `ai.x.grok.bot.MainActivity`), **but** patchers/stubs must preserve `ai.x.grok.bot` and `Lai/x/grok/bot/MainApplication;` because official `classes.dex` and Pairip checks cannot be recompiled from source. |
| `co.anysphere.sand` | `ios/patchers/ios/patch-app.py:154`, `ios/patchers/ios/extensions.py:46`, `ios/release/patch-ios.py:67-68`, `ci/official-channels.mjs:7`, `ci/official-channels.test.mjs:30`, `ios/tests/ios-release.test.py:52,60-61,117`, `android/recipes/manifest.json:6`, `android/release/patch-android.mjs:579`, `android/companion/src/main/java/dev/rokbot/nativeapp/RokBotSandApplication.java:4`, `android/companion/compile-stubs/src/main/java/co/anysphere/sand/MainApplication.java:1` | Official Apple App Store `CFBundleIdentifier` (and legacy Android `MainApplication` namespace). Required on iOS to validate decrypted `1.16.0` IPAs and the three extensions (`co.anysphere.sand.{widgets,share,NotificationService}`) before rewriting the output bundle ID to `dev.rokbot.local`; required in `ci/official-channels.mjs` for Apple iTunes Lookup verification; required in Android patcher/stubs to detect `Lco/anysphere/sand/MainApplication;`. |
| `com.anysphere.sand` | `mac/patchers/desktop/supported.json:3`, `mac/patchers/desktop/patch.mjs`, `ci/official-channels.test.mjs:168` | Official macOS Electron `CFBundleIdentifier` pinned in `supported.json` and checked against unmodified `Contents/Info.plist`, and matched when rewriting helper bundle IDs (`helper.CFBundleIdentifier.replace(supported.bundleId, info.CFBundleIdentifier)`). |
| `Grok Bot.app`, `Grok Bot.exe` (input lookup vs. output naming) | `mac/patchers/desktop/patch.mjs:85,87`, `windows/patchers/desktop/patch.mjs:31,134-135`, `windows/patchers/desktop/pe.mjs`, `windows/installer/main.go:26`, `web/patchers/patch.mjs:204` | **Input lookup is Category B; output naming & resources are Category A.** Inside the mounted official `.dmg` and extracted `app-64.7z`, the upstream bundle/executable must be looked up as `Grok Bot.app` / `Grok Bot.exe` (`pe.mjs` updates `ElectronAsarIntegrity` for `resources\\app.asar` in place and patches `Grok Bot.exe` PE `RT_ICON`/`RT_GROUP_ICON` and `RT_VERSION` via `WINDOWS_PE_VERSION_STRINGS`). Patched output app/installer names are rebranded (`RokBot.app` / `RokBotLocal-*-Setup.exe`). |
| `CUGrokBotService` & `Grok Bot Computer Use.app` | `mac/patchers/desktop/patch.mjs:174`, `mac/patchers/desktop/native-helper.mjs:4-18`, `mac/clients/desktop/local-services.mjs:47`, `web/client/bridge.js:57` | Official macOS Computer Use Mach-O helper at `Contents/Helpers/Grok Bot Computer Use.app/Contents/MacOS/CUGrokBotService`. `native-helper.mjs` patches the 10-byte Team ID at pinned binary offsets after verifying its SHA-256 (`ebcb4aeb...`), and `boot.computerUseHelperName` exposes `"Grok Bot Computer Use"` to the unmodified renderer. |
| `sand-op-launcher`, `sand-webauthn-signer` | `mac/patchers/desktop/patch.mjs:133` | Prebuilt native binaries inside `dist/native/` of the extracted official Electron `app.asar`. |

### 2.2 Official Feeds, Store Listings & Artifact Origins

| Identifier | Verified Locations | Technical Reason Preserved |
| --- | --- | --- |
| `api.x.ai` | `windows/tools/desktop-recipes/spec.mjs:168` (`wss://api.x.ai/`), `android/companion/src/main/java/dev/rokbot/nativeapp/GatewayEndpointRouter.java` (`matchesDomain(h, "x.ai")` in `isTargetCloudEndpoint`), `android/tests/{test-utils.mjs,tier1..4.test.mjs}` | Official xAI API and Realtime Voice origin hardcoded in unmodified official renderer/Hermes bundles. Must remain in mobile cloud-endpoint interception (`isTargetCloudEndpoint()`) and desktop dialable-origin anchors (`spec.mjs`). |
| `api2.cursor.sh` | `android/companion/src/main/java/dev/rokbot/nativeapp/GatewayEndpointRouter.java` (`isTargetCloudEndpoint`), `android/tests/m2-m5-features.test.mjs`, `ci/official-channels.mjs:11-12`, `ci/homepage-versions.mjs:12-13`, `ci/official-channels.test.mjs:7-8` | Serves two upstream roles: (1) hardcoded cloud API/SSE origin in official mobile RN bundles redirected by `GatewayEndpointRouter`, and (2) official Cursor/Anysphere release metadata API (`https://api2.cursor.sh/updates/api/download/stable/{win32-x64-user,darwin-arm64}/sand`) queried by CI channel checkers. |
| `downloads.cursor.com` | `ci/official-channels.mjs:50`, `ci/official-channels.test.mjs:24,148`, `mac/patchers/desktop/supported.json:6`, `windows/patchers/desktop/supported.json:5`, `windows/patchers/desktop/0.71.2/supported.json:5` | Official CDN serving unmodified `Grok_Bot_<ver>_Setup.exe` and `Grok_Bot_<ver>.dmg` installers checked by SHA-256 (overridable via `ROKBOT_DESKTOP_DOWNLOAD_BASE` mirror configuration). |
| `x.ai/changelog/bot` | `ci/official-channels-notes.py:10` (`https://x.ai/changelog/bot`, `rss.xml`, `<title>Grok Bot Changelog</title>`), `ci/official-channels-notes.test.py:8` | External vendor RSS feed parsed to track official Grok Bot changelog entries. |
| `docs.x.ai/grok-bot/deployment` | `ci/official-channels.mjs:9` | External official upstream deployment documentation URL referenced by channel metadata checks. |
| `apps.apple.com/us/app/grok-bot/id6794501026` | `ci/official-channels.mjs:8` (`iosListing`), `ci/official-channels.test.mjs:17`, `ci/homepage-versions.mjs:14` | Official Apple App Store listing (`trackId: 6794501026`, `trackName: 'Grok Bot'`, `bundleId: 'co.anysphere.sand'`) paired with `itunes.apple.com/lookup`. |
| `play.google.com/store/apps/details?id=ai.x.grok.bot` | External Google Play Store listing corresponding to `ai.x.grok.bot` (0 occurrences in repo; parallel to Apple App Store `id6794501026`) | External official Play Store product URL bound to upstream package ID `ai.x.grok.bot`. |
| `public.ecr.aws/k0i0n2g5/cursorenvironments/universal` | `host/recipes/host/manifest.json:8` | Official execution desktop (`box`) base image repository pinned by `manifestDigest` & `configDigest` (overridable at runtime via `ROKBOT_BOX_IMAGE` / GHCR `ghcr.io/hongfaqiu/rokbot/box`). |
| `public-asphr-vm-daemon-bucket.s3.us-east-1.amazonaws.com/sand-host-bundle/...` | `host/recipes/host/manifest.json:16`, `host/release/patch-host.py:77` | Official `sand-host-bundle-<rev>.tgz` S3 origin pinned by SHA-256 (overridable via `--archive` / `ROKBOT_HOST_ARCHIVE_URL`). |

<a id="category-b-mobile"></a>
### 2.3 Mobile Interception, Deep Links & Apple/Android Runtime Keys

| Identifier | Verified Locations | Technical Reason Preserved |
| --- | --- | --- |
| `/aiserver.v1.GrokBotService/*` (all 7 RPCs) | **Voice Minting**: `/aiserver.v1.GrokBotService/MintSandVoiceCallSecret` -> `/local/voice/session` (`android/companion/src/main/java/dev/rokbot/nativeapp/GatewayEndpointRouter.java:211`, `NetworkInterceptor.java:86`, `R8OkHttpInterceptor.java:60`, `ios/clients/ios/RBVoice.m:16`)<br>**App Intents**: `/aiserver.v1.GrokBotService/ListGrokBotAgents`, `/aiserver.v1.GrokBotService/SendGrokBotUserMessage`, `/aiserver.v1.GrokBotService/GetGrokBotSendStatus` -> `/local/app-intents/<method>` (`GatewayEndpointRouter.java:186`, `ios/clients/ios/RBAppIntents.m:54`, `host/server/mobile-app-intents.mjs:4,74`)<br>**Mobile Connectors**: `/aiserver.v1.GrokBotService/GetGrokBotMcpToolPermissions`, `/aiserver.v1.GrokBotService/SetGrokBotMcpToolPermissions`, `/aiserver.v1.GrokBotService/ListPublicGrokBotMarketplaceListings` -> `/local/mobile-rpc/<method>` (`GatewayEndpointRouter.java:41`, `host/server/connectors-mobile.mjs:22,211`, `android/tests/m2-m5-features.test.mjs`) | Hardcoded gRPC-Web / Connect RPC paths emitted by compiled official Hermes bundles (`index.android.bundle` / `main.jsbundle`) and Swift App Intents. Mobile OkHttp and `NSURLProtocol` interceptors must match these exact paths to route requests to Host `/local/*` endpoints. |
| `GetGrokBotMcpToolPermissions` | `android/companion/src/main/java/dev/rokbot/nativeapp/GatewayEndpointRouter.java:41`, `ios/clients/ios/RBConnectors.m:18`, `host/server/connectors-mobile.mjs:22,211`, `android/tests/mock-host.mjs`, `android/tests/m2-m5-features.test.mjs` | Official RPC method name for querying per-tool MCP permissions. Android routes it under `/aiserver.v1.GrokBotService/` while iOS intercepts it under `/aiserver.v1.DashboardService/`; Host dispatches it via `/local/mobile-rpc/GetGrokBotMcpToolPermissions`. |
| `/aiserver.v1.DashboardService/*`, `/aiserver.v1.AiService/TranscribeAudio`, `/aiserver.v1.AnalyticsService/*` | `android/companion/src/main/java/dev/rokbot/nativeapp/{GatewayEndpointRouter,NetworkInterceptor,R8OkHttpInterceptor}.java`, `ios/clients/ios/{RBConnectors,RBSpeech,RBPrivacy}.m`, `host/server/connectors-mobile.mjs` | Additional upstream Connect/gRPC routes: allowlisted `DashboardService` connector/marketplace methods, `AiService/TranscribeAudio` -> `/local/audio/transcriptions`, and `AnalyticsService/{TrackEvents,SubmitLogs}` blocked locally. |
| `GROK_BOT_TOOL_PERMISSION_*`, `GROK_BOT_SEND_STATUS_*`, `GROK_BOT_TEMPORAL_HARNESS_MODE_BOX`, `GROK_BOT_USER_MESSAGE_DELIVERY_*` | `host/server/connectors-mobile.mjs:80,91-92,246-258`, `host/server/mobile-app-intents.mjs:7,93-95` | Protobuf JSON enum string constants (`UNSPECIFIED`, `BLOCKED`, `ALWAYS_ALLOW`, `NEEDS_APPROVAL`, etc.) expected by official mobile RN/Swift deserializers. |
| `grokbot://app/v1/chat` | `android/companion/src/main/java/dev/rokbot/nativeapp/RokBotBootstrap.java:511-522,623` (`normalizeDeepLink`), `ios/clients/ios/RBDeepLinks.m:34`, `android/tests/m2-m5-features.test.mjs`, `android/tests/emulator-e2e.mjs` | Internal React Navigation deep-link URI parsed by official `GrokBotLinks` JS inside unmodified Hermes bundles. External `rokbot-local://agent/<id>` links are normalized to `grokbot://app/v1/chat?id=<id>` at the native boundary before passing to `RCTLinkingManager` / `ReactHostImpl`. |
| `sand-mobile`, `/updates/sand-mobile/api/manifest`, `SandAppGroupIdentifier`, `SandKeychainAccessGroups`, `GrokBotPresenceAppGroup`, `sand.cursor-tokens`, `GrokBotActionURL` | `ios/patchers/ios/patch-app.py:175-176,200`, `ios/patchers/ios/extensions.py:57,71`, `ios/patchers/ios/signing.py:60`, `ios/clients/ios/{RBAppIntents,RBDeepLinks}.m`, `android/companion/src/main/java/dev/rokbot/nativeapp/{NetworkInterceptor,R8OkHttpInterceptor}.java` | Official iOS Info.plist keys, Keychain account (`sand.cursor-tokens` with `kSecAttrService: @"app:no-auth"`), Swift widget symbol, and Expo OTA manifest URL path (`/updates/sand-mobile/api/manifest`) intercepted locally. |
| Intercepted cloud & telemetry domains | `android/companion/src/main/java/dev/rokbot/nativeapp/GatewayEndpointRouter.java` (`isTargetCloudEndpoint` / `isTelemetryHost`: `grok.bot`, `grok.ai`, `grok.com`, `x.ai`, `api2.cursor.sh`, `sand.cursor.sh`, `cursor.sh`, `cursor.com`, `anysphere.co`; telemetry `sentry.io`, `appboy.com`, `braze.com`, `appsflyer.com`, `appsflyersdk.com`, `statsig.com`, `statsigcdn.com`, `statsigapi.net`, `api3.cursor.sh`, `u.expo.dev`) | Upstream cloud origins redirected to the paired Host and third-party analytics/OTA origins blocked offline. |

### 2.4 Desktop Electron IPC & Preload RPC Surface

| Identifier | Verified Locations | Technical Reason Preserved |
| --- | --- | --- |
| `dune-rpc:main:*` & `dune-rpc:<edge>:*` | `mac/clients/desktop/main.mjs:86,178,192,204,367-370,381`, `mac/clients/desktop/platform.mjs:67`, `mac/clients/desktop/settings.mjs:21`, `mac/clients/desktop/voice.mjs:20`, `mac/clients/desktop/profile.mjs:13`, `web/client/bridge.js:69,191-197,207`, `windows/tools/inspect-desktop-preload.mjs:10` | Hardcoded IPC channel prefix (`dune-rpc:main:probe`, `dune-rpc:main:m:<method>`, `dune-rpc:main:e:<event>`, and multi-edge `desktop-mount`/`spotlight` channels) emitted by official `preload.cjs` and `dist/renderer/`. |
| `dune-rpc:main:m:*` method names & `experiments.featureGates` | `mac/clients/desktop/local-services.mjs` (`listGrokBotAgentFiles`, `uploadGrokBotAgentFile`, `deleteGrokBotAgentFile`, `listGrokBotUserStoreFiles`, `deleteGrokBotUserStoreFile`, `getGrokBotTermsRecord`, `markGrokBotTerms*`, `getSandAccess`, `getSandAccessFresh`, `getSandMachines`, `*Cursor*`, `*Box*`; gates `sand_create_temporal_agents`, `grok_bot_box_harness_turns_blocked`, `sand_profile_photo_edit`, `sand_teach_by_demonstration`, `sand_voice_call`, `sand_voice_resumption`) | Official RPC method names and feature-gate flags invoked by the unmodified Electron renderer UI. |
| `sand:*` Electron IPC channels | `mac/clients/desktop/main.mjs:277,339,344`, `mac/clients/desktop/preload-vnc.cjs:17`, `web/client/bridge.js:200,204,211`, `windows/tools/inspect-desktop-preload.mjs:9-10` | Official preload IPC channels (`sand:boot-snapshot-sync`, `sand:coordinator-port-request`, `sand:coordinator-port`, `sand:vnc-session`). |

### 2.5 Host Runtime (`sand-host`) & `SAND_*` Variables

| Identifier | Verified Locations | Technical Reason Preserved |
| --- | --- | --- |
| `sand-host` | `host/release/patch-host.py:84`, `host/release/Dockerfile.host:11,16`, `host/runtime/host-resources.mjs:8,10`, `host/runtime/remote-box.mjs:64`, `host/recipes/host/manifest.json:477,1197`, `host/tests/bytepatch_checks.py:31,33`, `host/tests/deployment.test.mjs` | Directory layout inside official `sand-host-bundle-<rev>.tgz` (`sand-host/host-main.cjs`, `sand-host/version`, `sand-host/node_modules`), Docker `NODE_PATH` isolation checks, and recipe target filenames (`host-kernel-sand-host.mjs`). |
| `SandHost` | `host/runtime/host.mjs:66`, `host/runtime/recovered-host-execution.mjs:20` | Exported constructor symbol extracted from official `host-main.cjs` into `host-library.cjs`. |
| `SAND_*` env vars & library keys | `host/runtime/host.mjs:23-31,138`, `host/runtime/reliability/tool-journal.mjs`, `host/runtime/{host-attachments,host-skills,sharing-client}.mjs`, `mac/clients/desktop/main.mjs:37-38`, `host/release/compose.yaml:16` (`SAND_BOX_MAX_WINDOWS: ${SAND_BOX_MAX_WINDOWS:-100}`), `host/runtime/host-auto-review.mjs:35,54,69,99`, `host/tests/{memory-extraction,auto-review}.test.mjs` | Process env flags (`SAND_DATA_ROOT`, `SAND_BACKEND_URL`, `SAND_DISABLE_TELEMETRY`, `SAND_DISABLE_ANALYTICS`, `SAND_DISABLE_UPDATES`, `SAND_BOX_AUTO_UPDATE`, `SAND_BOX_STORE_SYNC`, `SAND_BOX_STORE_COPY_IN`, `SAND_HOST_IN_BOX`, `SAND_PACKAGED`, `SAND_BOX_MAX_WINDOWS`) and exported library symbols (`SAND_AUTO_REVIEW_CLASSIFIER_SYSTEM_PROMPT`, `CLASSIFY_SAND_AUTO_REVIEW_ACTION_TOOL`) read directly by closed-source `host-main.cjs` and Electron preloads. |
| `sand_multi_machine_local_exec` | `host/runtime/host.mjs:99` | Official Host feature-gate key enabling multi-machine desktop execution routing. |
| Upstream `sand-*` DOM/CSS selectors | `web/client/android.css`, `web/client/web.css`, `web/client/layout.js`, `mac/clients/desktop/workspace.css` | Official React/Electron DOM component classes (`data-component`, `sand-*`, including `.sand-grok-bot-mark` overridden with the RokBot logo) matched for responsive layout and brand mark replacement. |

---

## 3. Migration & Compatibility Bridges

### 3.1 Host `.env`, Compose & Runtime Migration Fallbacks (`host/` ONLY)

To ensure smooth upgrades from existing `.env` deployments (such as `/Volumes/ORICO/grokbot/.env`) and `d0a4baa` byte-patch recipes without forcing manual edits during rollout:

- **Compose & `.env` fallbacks**: `host/release/compose.yaml:15` defines `ROKBOT_DEFAULT_MACHINE_ID: ${ROKBOT_DEFAULT_MACHINE_ID:-${GROKBOT_DEFAULT_MACHINE_ID:-}}` (with `ROKBOT_*` primary and `GROKBOT_*` / `PROKBOT_EXISTING_VOLUMES` fallbacks across `host/release/compose.yaml`, `host/release/compose.host.yaml`, and `host/release/compose.execution.yaml`). `host/deploy.py:72-79,484`, `host/deploy/{supervisor,execution-gateway,execution-tailcat,healthcheck}.mjs`, `host/server/index.mjs`, `host/tools/host-admin.mjs`, `host/release/patch-host.py:77`, and `host/tests/bytepatch_checks.py:24` (`ROKBOT_TEST_HOST_ARCHIVE` primary with `PROKBOT_TEST_HOST_ARCHIVE` fallback) adopt `ROKBOT_*` as primary keys and accept `GROKBOT_*` / `PROKBOT_MODE` / `PROKBOT_PROJECT` **only** inside `host/` for migration compatibility.
- **Host recipe & runtime compatibility bridges (M1.3.1)**:
  - `host/release/Dockerfile.host:15,21`: creates `ln -s /opt/rokbot /opt/grokbot` and sets `GROKBOT_RUNTIME_DIR=/opt/rokbot/runtime` alongside `ROKBOT_RUNTIME_DIR=/opt/rokbot/runtime` so `d0a4baa` `.gbp.gz` recipes (including `agent-store-worker.cjs.gbp.gz`) keep resolving until M2 regenerates `2bb5e41` recipes.
  - `host/release/bytepatch.py:11-13`: emits `rokbot-bytepatch/v1` while accepting `grokbot-bytepatch/v1` in `ACCEPTED_SCHEMAS` until M2 regenerates `2bb5e41` recipes.
  - `host/runtime/prompt-runtime.mjs:70-79`: installs `globalThis.__rokbotPromptPolicy` and mirrors `globalThis.__grokbotPromptPolicy` for `prompt-tools-system-prompt-assembly.mjs.gbp.gz` until M2 regenerates `2bb5e41` recipes.
  - `host/runtime/model-common.mjs:258-259`: `reasoningOrigin()` reads `providerOptions?.rokbot ?? experimental_providerMetadata?.rokbot` and falls back to `providerOptions?.grokbot ?? experimental_providerMetadata?.grokbot` when replaying historical reasoning parts.
  - `host/release/backup.py:135,338`: accepts legacy `prokbot-operation-` / `prokbot-lineage-operation-` lock prefixes alongside `rokbot-operation-` / `rokbot-lineage-operation-`, and `read_manifest()` accepts both `rokbot-volumes/v1` and legacy `grokbot-volumes/v1` backup manifests.
- **Scope boundary**: Client components (`mac/`, `windows/`, `web/`, `android/`, `ios/`) do **not** read `GROKBOT_*` or `PROKBOT_*` runtime env vars (see Section 3.3 for retained binary ABI compatibility layers).

### 3.2 Incremental Delta Update Formats (`RBDELTA1` / `RBD1` + Legacy Read-Compat)

- **Primary RokBot formats**:
  - Android APK ZIP-entry incremental delta: magic header `RBDELTA1` (`.rbdelta`, schema `rokbot-android-native-update/v1` / `rokbot-android-update/v1`).
  - Desktop ASAR/installer incremental delta: magic header `RBD1` (`rokbot-delta/v1`, schema `rokbot-desktop-update/v1`).
- **Read-compatibility bridge**: Delta appliers/parsers (`android/release/delta-update.mjs:29-30`, `android/companion/src/main/java/dev/rokbot/nativeapp/DeltaPatcher.java:16`, `mac/clients/shared/delta.mjs:8-9`) retain read-compatibility for legacy `GBDELTA1` / `GBD1` headers (and `.gitignore:19-20` ignores both `*.rbdelta` and `*.gbdelta`) so clients upgrading from pre-rebrand builds can apply existing delta artifacts cleanly.

<a id="staged-client-rebrands"></a>
### 3.3 Retained Native Library ABI Bridges & Completed M1.3–M1.5 Client Rebrands

The following items reflect (a) permanent binary ABI / vendored library compatibility layers, and (b) client & CI rebrands completed across M1.3, M1.4, and M1.5:

| Item | Current Verified Disk State | Status |
| --- | --- | --- |
| `android/bin/jniLibs/arm64-v8a/libgroktailcat.so` & `libgroktailcatjni.so` + `dev.grokbot.local.TailcatBridge` | `strings android/bin/jniLibs/arm64-v8a/libgroktailcatjni.so` confirms embedded `tailcat_jni.c` (C JNI source absent from repo) exporting `Java_dev_grokbot_local_TailcatBridge_{nativeIdentity,nativeStart,nativeStatus,nativeStop}` and `GBTailcat{Identity,Free,Start,Status,Stop}`. Checksum-pinned in `ci/verify-release.py:36-37` (`HELPERS`), `android/patchers/dex.mjs:15`, and `android/recipes/manifest.json:12-13`, and loaded by `android/companion/src/main/java/dev/grokbot/local/TailcatBridge.java` (matching `android/README.md:16`). | **Retained permanently as a Category-B JNI ABI compatibility layer** unless upstream C/Go JNI source is restored and recompiled under `dev.rokbot.*`. |
| `ios/clients/ios/audio-processing/prebuilt/ios-arm64/libGBAudioProcessing.a` (`GBAudioProcessing.{h,cc}`) | Vendored prebuilt WebRTC AEC3 static library (`ios/clients/ios/audio-processing/prebuilt/ios-arm64/{libGBAudioProcessing.a,GBAudioProcessing.h,build.json}` and `ios/clients/ios/audio-processing/GBAudioProcessing.{h,cc}`), linked into `ios/bin/RokBotLocal.dylib` by `ios/clients/ios/build.py:20`. | **Retained permanently as a vendored WebRTC AEC3 ABI artifact** unless rebuilt from source with renamed C/C++ symbols. |
| `host/bin/**/rokbot-tailcat`, `mac/dist/network/rokbot-tailcat`, `windows/dist/network/rokbot-tailcat.exe`, `windows/dist/installer/rokbot-setup-stub.exe` | All helper binaries are renamed to `rokbot-*` on disk (`host/bin/rokbot-tailcat`, `host/bin/linux-arm64/rokbot-tailcat`, `mac/dist/network/rokbot-tailcat`, `windows/dist/network/rokbot-tailcat.exe`, `windows/dist/installer/rokbot-setup-stub.exe`). `.gitattributes`, `mac/`, `windows/`, `ci/release-packages.py`, `ci/verify-release.py`, and `ci/test_verify_release.py` all reference the `rokbot-*` paths directly. | **Completed in M1.3.1 / M1.5** (zero transitional desktop `grokbot-*` helper filenames remain). |
| Mobile, `ios/bin/RokBotLocal.dylib`, `web/`, `windows/` & `ci/` rebrands | `android/companion/src/main/java/dev/rokbot/nativeapp/RokBot*.java`, `android/release/patch-android.mjs` (`~/.rokbot-local/android-signing.json`), `ios/clients/ios/RB*.{h,m}`, `ios/bin/RokBotLocal.dylib`, `web/` (`ROKBOT_ADMIN_PASSWORD`, `ROKBOT_WEB_TEST_*`), `windows/` (`RokBotLocal-*`, `dev.rokbot.local`), and `ci/` (`rokbot-box-input:*`, `.rbdelta`, `RokBotLocal-*`, `assets/logo` packaging) are all rebranded and reconciled. | **Completed in M1.3.2 / M1.4 / M1.5** (legacy `ios/bin/GrokBotLocal.dylib` removed). |
| Platform UI, PE/plist resources & notification/splash rebrands | Web (`<title>RokBot</title>`, Notification `icon`, `.sand-grok-bot-mark` override), Windows (`pe.mjs` `replaceResources` for `RT_ICON`/`RT_GROUP_ICON` & `RT_VERSION` `WINDOWS_PE_VERSION_STRINGS`), macOS/Desktop (`applyRokBotHelperInfoPlist`, `normalizeDesktopWindowTitle`, `workspace.css` `.sand-grok-bot-mark`), Android (`NotificationService.applySmallIcon()`, splash/notification drawables in `patch-android.mjs`, `app.config` name in `hermes.mjs`), iOS (`prepare_extensions` `CFBundleName`/`CFBundleDisplayName`, `rebrand_info_strings` for `*.lproj/InfoPlist.strings`, `NS*UsageDescription` & `UILaunchScreen`/`CFBundleIcons~iphone` cleanup in `patch-app.py`). | **Completed** (Category-B `grokbot://app/v1/chat`, `co.anysphere.sand`, `ai.x.grok.bot`, `Grok Bot.exe`, `grokbot-bytepatch/v1` 1.2.3 recipe parity preserved). |

<a id="historical-attribution"></a>
## 4. Historical Attribution & License Exemptions

RokBot is licensed under the **RokBot Noncommercial License 1.0** (see [`LICENSE`](../LICENSE)). In accordance with the upstream **ProkBot Noncommercial License 1.0** (kept unchanged in [`LICENSES/ProkBot-Noncommercial-1.0.txt`](../LICENSES/ProkBot-Noncommercial-1.0.txt)), the following references are intentionally preserved and exempt from Category-A replacement:

1. **`ProkBot`**: `https://gitee.com/ahaduoduoduo/ProkBot` (`release v2026.11.05, commit 3e9fe8c`, `Copyright (c) 2026 ProkBot contributors`) in [`NOTICE`](../NOTICE), [`README.md`](../README.md), and [`README.en.md`](../README.en.md).
2. **`ProkBot Plus`**: `https://github.com/ferretgeek/prokbot-plus` (`referenced through 1.5.1`, `Copyright (c) 2026 ProkBot Plus contributors`) in [`NOTICE`](../NOTICE), [`README.md`](../README.md), and [`README.en.md`](../README.en.md).
3. **Trademark disclaimers**: Statements referencing `xAI`, `Grok`, `Grok Bot`, and `Cursor/Anysphere` to clarify non-affiliation in [`NOTICE`](../NOTICE), [`README.md`](../README.md), and [`README.en.md`](../README.en.md).

All operational repository links (clone commands, issue/advisory links, release workflows, GHCR image namespaces) point to `https://github.com/hongfaqiu/rokbot`.

---

## 5. Verification & Grep Audit Guide

When auditing documentation and root files after M1.3.3, use:

```sh
# 1. Check root & docs (excluding this registry) for unintended Category-A leftovers
rg -n -i "(ferretgeek|prokbot|ahaduoduoduo|grokbot_admin|grokbot_web|grokbot_vnc|x-grokbot|GROKBOT_|PROKBOT_|grokbot-host|grokbot-box|grokbot-app|grokbot-web-bundle|grokbot-local://|~/grokbot|/opt/grokbot|\.grokbot-local|providerOptions\.grokbot|grokbot-native-base|grokbot-android-shell|grokbot-tailcat|gbdelta|GBDELTA1|GBD1|grokbot-setup-stub|GrokBotLocal|dev\.grokbot)" \
  README.md README.en.md SECURITY.md NOTICE .gitignore .gitattributes \
  docs/AI-INSTALL.md docs/AI-INSTALL.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md

# 2. Confirm zero stale deleted legacy paths anywhere in docs or root files
rg -n "(android[/]shell|android[/]client|android[/]dist|android[/]patchers[/]patch\.mjs|android[/]patchers[/]supported\.json|android[/]patchers[/]apk\.mjs|android[/]patchers[/]renderer-patches\.mjs|src[/]android|grokbot-android-shell|native[_]pairing_origin|AGENTS[.]md|CHANGELOG[.]md)" \
  README.md README.en.md SECURITY.md NOTICE .gitignore .gitattributes \
  docs/AI-INSTALL.md docs/AI-INSTALL.en.md docs/ARCHITECTURE.md docs/ARCHITECTURE.en.md
```

Expected results:
- Command 1: Matches **only**:
  - Historical attribution / license lines in `README.md` (`23, 24, 26, 84`), `README.en.md` (`23, 24, 26, 84`), and `NOTICE` (`5, 7, 8, 10, 11, 13, 14, 16, 17, 19, 64`);
  - Migration `.gitignore` entries (`20:*.gbdelta`, `38:.grokbot-local/`);
  - **0 matches** in `.gitattributes`, `SECURITY.md`, `docs/AI-INSTALL*.md`, and `docs/ARCHITECTURE*.md`.
- Command 2: **0 matches** (exit code `1`). Note: `[/]`, `[_]`, and `[.]` character-class escaping keeps this audit guide free of bare legacy-path substrings even under naive full-directory scans of `docs/`.

---

## 6. Upgrade & Invalidation Checklist

Whenever pinned official upstream baselines are upgraded (e.g., Host `2bb5e41+`, Desktop `1.2.3+`, Mobile `1.16.0+`), re-verify:

1. **Package / Bundle IDs**: Confirm `ai.x.grok.bot`, `co.anysphere.sand`, and `com.anysphere.sand` still match official input manifests and Info.plist / AndroidManifest checks.
2. **RPC / IPC Surfaces**: Audit new or renamed `/aiserver.v1.*`, `dune-rpc:*`, `sand:*`, `SAND_*`, and `GROK_BOT_*` symbols in unpacked official archives before updating interceptors or recipes.
3. **Bridge Retirement**: Remove legacy `GROKBOT_*` / `PROKBOT_*` `.env` fallbacks, Host `d0a4baa` recipe shims, and `GBDELTA1` / `GBD1` read-compat from Section 3 only when the corresponding milestone explicitly retires them. Keep the `libgroktailcat*.so` + `dev.grokbot.local.TailcatBridge` JNI ABI entry and `ios/clients/ios/audio-processing/prebuilt/ios-arm64/libGBAudioProcessing.a` unless the native libraries are rebuilt from source.
