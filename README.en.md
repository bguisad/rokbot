<p align="center">
  <img src="assets/logo/rokbot-icon-256.png" width="112" alt="RokBot Logo" />
</p>

<h1 align="center">RokBot</h1>

<p align="center">
  <strong>Your private, cross-platform AI assistant — one-click self-hosting, bring your own models, native experience everywhere.</strong>
</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <strong>English</strong> ·
  <a href="docs/AGENT_DEPLOY.en.md">AI Agent Deploy Runbook</a> ·
  <a href="docs/PATCHING_WORKFLOW.en.md">How It Works</a> ·
  <a href="docs/ARCHITECTURE.en.md">Architecture</a>
</p>

> RokBot is an independent open-source product for personal self-hosting (inspired by ProkBot, prokbot-plus, and rakazo), built so anyone can run a fast, private, native AI assistant across all their devices.

---

## Highlights

- **3-Minute One-Click Deploy**: Prebuilt Docker images and a single setup script get your server running without cloning the repo or building from source.
- **Native Apps Everywhere**: Supports **macOS, Windows, Android, iOS, and Web** with native client builds — no sluggish wrapper apps.
- **In-App Model Configuration**: Connect OpenAI, Anthropic, or any compatible provider directly inside the mobile or desktop app — fetch available models, run a live latency test, hot-reload with one tap, and assign different models per Bot.
- **Hands-On Sandbox & Multi-Machine Execution**: Includes an isolated Linux sandbox for running code, searching, and managing files, plus optional multi-machine routing to your own desktops.
- **Self-Hosted Incremental Auto-Updates**: Upload your signed packages once in the Admin Console; the Host automatically generates signed delta patches so all four client platforms can update in one click.
- **Privacy First**: Everything stays on your own server. API keys are write-only, and cloud telemetry is disabled.

---

## Screenshots

Live captures from Android and the self-hosted Admin Console (accounts, host addresses, and credentials are masked):

| Android Launcher | Pairing | In-App Model Config | Streaming Chat & Sandbox |
| --- | --- | --- | --- |
| <img src="docs/images/rokbot-android-launcher.png" width="210" alt="RokBot Android icon" /> | <img src="docs/images/rokbot-android-pairing.png" width="210" alt="RokBot pairing screen" /> | <img src="docs/images/rokbot-android-models.png" width="210" alt="RokBot in-app model config" /> | <img src="docs/images/rokbot-android-chat.png" width="210" alt="RokBot chat and sandbox execution" /> |

| Admin Overview | Models & Bot Routing | 4-Platform Update Publisher |
| --- | --- | --- |
| <img src="docs/images/rokbot-host-admin-overview.png" width="280" alt="RokBot Admin overview" /> | <img src="docs/images/rokbot-host-admin-model.png" width="280" alt="RokBot model routing" /> | <img src="docs/images/rokbot-host-admin-updates.png" width="280" alt="RokBot 4-platform updates" /> |

---

## Quick Start

### 1. Deploy the Server (Host)

On any Linux or macOS machine with Docker (Compose v2):

```bash
mkdir rokbot && cd rokbot
curl -fsSL https://raw.githubusercontent.com/hongfaqiu/rokbot/main/host/release/install-images.sh -o install-images.sh
bash install-images.sh
```

The script generates `.env`, pulls the images, starts the stack, and waits until health checks pass.

> [!TIP]
> - **Want an AI agent to deploy it for you?** Point Claude Code, Cursor, Codex, or Antigravity to [`docs/AGENT_DEPLOY.en.md`](docs/AGENT_DEPLOY.en.md) for a step-by-step automated runbook.
> - **Useful flags**: `--local` (use a local repo clone), `--prepare-only` (generate `.env` to edit before starting), `--offline` (air-gapped hosts). Configure `ROKBOT_HOST_IMAGE` / `ROKBOT_BOX_IMAGE` or `HTTP_PROXY` / `HTTPS_PROXY` in `.env` for mirrors or proxies.

### 2. Initialize & Pair a Client

1. Read your one-time setup key:
   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
   ```
2. Open `http://127.0.0.1:18080/admin`, enter the setup key, and create your admin password.
3. Generate a 6-character pairing code under **Devices** (or sign in with the admin password) from any RokBot client.

### 3. Configure a Model In-App & Start Chatting

On first connection, the client guides you straight to **Model Config**:
1. Pick a provider type (OpenAI, Anthropic, etc.) and enter your Base URL and API key.
2. Tap **Fetch Models** to load available models, then **Test Connection** to verify reachability and latency.
3. Tap **Save & Apply** — once the status shows active, create a Bot and start chatting.

---

## Clients & Auto-Updates

### Getting the Clients

This repository does not redistribute proprietary third-party binaries; each client is assembled locally from verified packages:

| Platform | Version | Build & Usage Guide |
| --- | --- | --- |
| **macOS** (Apple Silicon) | `1.2.3` | [`mac/README.en.md`](mac/README.en.md) |
| **Windows** (x64 Setup / Portable) | `1.2.3` | [`windows/README.en.md`](windows/README.en.md) |
| **Web** (Browser PWA) | `1.2.3` | [`web/README.en.md`](web/README.en.md) |
| **Android** (Native APK) | `1.16.0` | [`android/README.en.md`](android/README.en.md) |
| **iOS** (Native IPA, requires decrypted IPA) | `1.16.0` | [`ios/README.en.md`](ios/README.en.md) |

### One-Click Incremental Updates

- **Publishing (Admin)**: Open `/admin?view=updates`, choose a platform, upload your signed package, and optionally select a previous version so the Host automatically builds a delta patch.
- **Updating (Users)**:
  - **Android / macOS / Windows**: Tap **Check for Updates** in the app (desktop also supports automatic idle updates) to download the lightweight delta, verify its signature, and install.
  - **iOS**: Check for updates in-app to install via `itms-services` OTA (requires HTTPS `ROKBOT_PUBLIC_URL`), AltStore / SideStore, or IPA share sheet.

---

## Documentation

| Guide | Topics |
| --- | --- |
| [`docs/AGENT_DEPLOY.en.md`](docs/AGENT_DEPLOY.en.md) | Step-by-step deployment, health verification, model config, and update publishing runbook for AI agents |
| [`docs/PATCHING_WORKFLOW.en.md`](docs/PATCHING_WORKFLOW.en.md) | Technical deep dive into self-hosting adaptation and per-platform patching |
| [`docs/AI-INSTALL.en.md`](docs/AI-INSTALL.en.md) | Offline source builds, split execution nodes, and volume backup/restore |
| [`docs/ARCHITECTURE.en.md`](docs/ARCHITECTURE.en.md) | System architecture, module boundaries, and runtime extensions |
| [`docs/REBRAND_COMPAT.md`](docs/REBRAND_COMPAT.md) | Environment variables, headers, and legacy migration compatibility |
| [`tests/e2e/README.md`](tests/e2e/README.md) | Running the 199-test opaque-box E2E test suite |

---

## Credits & License

- **Credits**: Inspired by the pioneering self-hosting and deployment work of [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot), [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus), and `rakazo`.
- **License**: Released under the [ProkBot Noncommercial License 1.0](LICENSE) — personal use, study, modification, and noncommercial distribution only; commercial use is prohibited. See [NOTICE](NOTICE).
- **Disclaimer**: RokBot is an independent open-source project and is not affiliated with xAI, Grok Bot, or Cursor/Anysphere. See [SECURITY.md](SECURITY.md) for security reporting.
