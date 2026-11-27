<p align="center">
  <img src="assets/logo/rokbot-logo.svg" width="112" alt="RokBot" />
</p>

<h1 align="center">RokBot</h1>

<p align="center">
  A private AI assistant on your own server: your data stays local, you choose the models, and you can pick up where you left off on web, desktop or phone.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Noncommercial%201.0-f59e0b?style=flat-square" alt="License: RokBot Noncommercial License 1.0" /></a>
  <a href="docs/clients.en.md"><img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20iOS%20%7C%20Android%20%7C%20Web-111827?style=flat-square" alt="Platforms: macOS, Windows, Linux, iOS, Android, Web" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/Deploy-Docker%20Compose-0ea5e9?style=flat-square" alt="Deploy: Docker Compose" /></a>
</p>

<p align="center">
  <a href="docs/media/rokbot-promo.mp4">
    <img src="docs/media/rokbot-promo-teaser.webp" width="800" alt="RokBot promo teaser: the Bot's computer, multi-device handoff, image generation, voice chat and model choice" />
  </a>
  <br />
  <sub><a href="docs/media/rokbot-promo.mp4">Watch the full promo video (80 seconds, with narration; in Chinese)</a></sub>
</p>

<!-- 用户可在 GitHub 网页编辑器中把 mp4 拖入此处，生成 user-attachments 链接后即可内嵌播放 -->

<p align="center">
  <a href="README.md">简体中文</a> ·
  <strong>English</strong> ·
  <a href="#features">Features</a> ·
  <a href="#new-directions--roadmap">Roadmap</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#get-the-clients">Get the Clients</a> ·
  <a href="#how-rokbot-differs-from-upstream">Upstream Comparison</a> ·
  <a href="#documentation">Documentation</a>
</p>

## Features

### <img src="docs/images/icons/server.svg" width="22" height="22" alt="" /> Self-hosting & Data

<img src="site/img/admin-models.webp" width="420" align="right" alt="Admin console Chat model page: providers, profiles and default route" />

- **Your data stays on your machine:** the Host and the execution desktop run in Docker on your server; chats, files, settings and API keys live on local volumes, and telemetry is off on every client.
- **Choose your own models:** works with OpenAI Chat Completions, OpenAI Responses and Anthropic Messages, so you decide which provider and model to use.
- **Per-scenario model routing:** input suggestions, context compaction, memory extraction, auto-review, sub-agents and routines can each use their own model and reasoning effort, and any single Bot can have its own model too.
- **Automatic fallback when the main model fails:** each route takes up to 8 fallback models; on error RokBot switches automatically, and never swaps models in the middle of a reply that has started streaming.
- **Migrate from Grok Bot:** read the local Grok Bot data in one click, or copy a migration prompt so Grok Bot exports its memories, skills and routines; review, then import, as often as you like without duplicates. See the [migration guide](docs/migrate-from-grokbot.md) (Chinese).
- **No cloud account needed:** pair with a single-use 6-digit code, and reach the Host remotely through the built-in Tailcat network, Tailscale or an HTTPS reverse proxy.

<br clear="right" />

### <img src="docs/images/icons/devices.svg" width="22" height="22" alt="" /> Every Platform

<img src="site/img/desktop-chat.webp" width="420" align="right" alt="Desktop chat window" />

- **Six platforms:** web, Mac, Windows, Linux (x64 / arm64), Android and iOS all connect to one Host, so a task you start on your computer can be followed on your phone.
- **Desktop auto-update:** desktop 1.3.1 checks for new versions through Client updates on your own Host and supports delta updates that only download what changed.
- **Android upgrades in place:** Android releases are all signed with the RokBot release key, so a new version installs over the old one without uninstalling.
- **Native Android client:** native screens plus system share, a native image viewer and multi-select batch saving to the gallery.

<br clear="right" />

### <img src="docs/images/icons/message.svg" width="22" height="22" alt="" /> Chat Experience

<img src="site/img/android-image-generation.webp" width="200" align="right" alt="Android client chatting with a design Bot that generates images" />

- **Input suggestions v2:** the suggestion bar above the composer can be turned off entirely, or you can turn off only the AI-generated part.
- **Custom quick phrases:** your phrases are stored on the Host and sync across desktop, web and Android.
- **Tap to send:** tapping a suggestion sends it right away.
- **Shown only on focus:** the suggestion bar appears only while the composer has focus.
- **Smart, context-aware:** in a conversation with history the model writes suggestions from the current context; a blank chat shows only your quick phrases.
- **Uploads without a size limit:** files between your computer and the Bot's workspace are streamed in chunks, with no per-file size limit by default.
- **Voice:** voice input and voice calls, with speech recognition and synthesis on services you configure.
- **Image generation:** image and video generation each take their own model, results come back as attachments, and you can batch-download several at once.

<br clear="right" />

### <img src="docs/images/icons/bot.svg" width="22" height="22" alt="" /> Bots That Manage Themselves

<img src="site/img/android-bot-details.webp" width="200" align="right" alt="Android client Bot details with routines, library, the Bot's computer and instructions" />

- **Memory:** a Bot can update and recall its long-term memory on your own Host.
- **Routines:** a Bot can edit its own routines and check their run history.
- **Tracked tasks:** progress and results of tracked tasks show up in the conversation.
- **Profile edits:** a Bot can update its own profile.
- **Skill writing:** a Bot can write and update its own skills.
- **New Bots:** a Bot can create new agents directly.
- **Reasoning effort:** a Bot can adjust its own reasoning effort.
- **Forms in chat:** when a Bot needs more information, it pops up a form in the conversation for you to fill in.

<br clear="right" />

### <img src="docs/images/icons/users.svg" width="22" height="22" alt="" /> Group Chats

<img src="site/img/android-bot-list.webp" width="200" align="right" alt="Android client chat list grouped into Needs attention, In progress, Unread and Read" />

- **Multi-Bot group chats:** bring several Bots into one group to work together, up to 6 Bots per group.
- **Android group creation matches desktop:** Android now creates groups on a single page with a "To:" recipient bar, and names groups the same way desktop does.
- **Create while you pick:** you can create a new Bot right from the member picker and add it to the group.
- **Automatic rollback:** if group creation fails, completed steps are undone so no half-built group is left behind.

<br clear="right" />

### <img src="docs/images/icons/palette.svg" width="22" height="22" alt="" /> RokBot's Own Design

<img src="site/img/android-models.webp" width="200" align="right" alt="Android client model settings page" />

- **RokBot's own pickers and controls:** native system drop-downs on model routing pages are replaced by RokBot-style menus, shown as bottom sheets on Android.
- **Light and dark themes:** menus, bottom sheets and settings follow the system theme and the Chinese or English interface.
- **Animated avatars:** Bots use RokBot animated avatars by default, across 26 shapes, with an in-app style switcher.
- **Unified icons:** the desktop, in-app and About page icons all use the RokBot mark.

<br clear="right" />

### <img src="docs/images/icons/monitor.svg" width="22" height="22" alt="" /> Remote Computer & Local Execution

<img src="site/img/desktop-live-vnc.webp" width="420" align="right" alt="Desktop client watching and taking over the Bot's computer live" />

- **The Bot's computer:** a built-in Linux desktop container where you can watch and take over the Bot live over VNC.
- **Remote execution node:** the built-in desktop can be swapped for a remote Linux machine under Execution environment in the admin console.
- **Work on your own computer:** a Bot can run commands and drive the GUI on a Mac, and run local commands on Windows.
- **No open ports:** clients connect out to the Host, so your computer never opens a port; sensitive actions go through auto-review and approval cards first.

<br clear="right" />

See [docs/features.en.md](docs/features.en.md) for the full feature guide, [Screenshots](docs/screenshots.en.md) for more screens, and the [2026-11-27 release notes](docs/releases/2026-11-27.md) (Chinese) for recent changes.

## New Directions & Roadmap

<img src="docs/images/icons/map.svg" width="22" height="22" alt="" /> The following features are in development or planned and **are not available yet**:

| Feature | Description | Status |
| --- | --- | --- |
| Local canvas | Bots generate interactive pages hosted by your own Host | In development |
| Inline completion | Gray ghost text suggests the rest of the sentence as you type; press Tab to accept | In development |
| Suggestion loading animation | An animation while input suggestions are being generated | In development |
| Suggestion settings entry | Input suggestion settings move to the top level of Settings | Coming soon |
| iOS feature parity | The iOS client catches up on all of the new features above | Coming soon |
| Automated releases | GitHub Releases published automatically with delta patch packages attached | Coming soon |
| Website redesign | A black-and-white redesign of the website | Coming soon |

## Quick Start

<img src="docs/images/icons/rocket.svg" width="22" height="22" alt="" /> On a Linux or macOS server with Docker (including Compose v2):

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub username> --password-stdin
gh repo clone hongfaqiu/rokbot rokbot-src
mkdir rokbot && cd rokbot
bash ../rokbot-src/host/release/install-images.sh --local
docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
```

Open `http://127.0.0.1:18080/admin`, use the setup key to set an admin password, then add a model service under Chat model and make it the default route.

For options, offline installs, source builds and AI-assisted deployment, see [Deployment Guide](docs/deployment.en.md) · [AI Agent Deploy Runbook](docs/AGENT_DEPLOY.en.md) · [Operations & Backup](docs/AI-INSTALL.en.md).

## Get the Clients

<img src="docs/images/icons/download.svg" width="22" height="22" alt="" /> This repository does not distribute installers. Patch the official installers yourself following [Getting the Clients](docs/clients.en.md), or download them from Client updates on a deployed Host, then pair with a 6-digit code from the admin console.

## How RokBot Differs from Upstream

<img src="docs/images/icons/compare.svg" width="22" height="22" alt="" /> RokBot is derived from the upstream open-source projects [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) and [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus) (see [NOTICE](NOTICE)).

| Area | Official app | ProkBot | prokbot-plus | RokBot |
| --- | --- | --- | --- | --- |
| Hosting & data | Official cloud | Self-hosted Docker | Self-hosted, with ARM64 and backup/restore | Self-hosted with one-script prebuilt-image deploy |
| Model routing | Official models only | Bring your own model | Per-Bot routes and fallbacks | 6 scenario routes, up to 8 fallbacks each |
| Clients | Official apps | macOS, iOS | Adds Windows and web | Six platforms, adds Linux and native Android |
| Chat & Bots | Official cloud features | Core chat and cloud desktop | App catalog, webhooks, usage stats | Input suggestions v2, self-managing Bots, native group creation |
| Privacy | Official account and telemetry | Telemetry off | Telemetry off | Telemetry off everywhere, write-only API keys |

## Documentation

<img src="docs/images/icons/book.svg" width="22" height="22" alt="" />

| Document | Contents |
| --- | --- |
| [docs/features.en.md](docs/features.en.md) | Full feature guide |
| [docs/screenshots.en.md](docs/screenshots.en.md) | Android, desktop and admin console screenshots |
| [docs/deployment.en.md](docs/deployment.en.md) | Deployment steps, script flags, initialization and model setup |
| [docs/clients.en.md](docs/clients.en.md) | Supported versions, per-platform build commands and Host distribution |
| [docs/architecture-overview.en.md](docs/architecture-overview.en.md) | Architecture overview |
| [docs/faq.en.md](docs/faq.en.md) | FAQ and distribution/compliance notes |
| [docs/releases/2026-11-27.md](docs/releases/2026-11-27.md) | 2026-11-27 release notes (Chinese) |
| [docs/AGENT_DEPLOY.en.md](docs/AGENT_DEPLOY.en.md) | Deployment runbook for AI coding agents |
| [docs/AI-INSTALL.en.md](docs/AI-INSTALL.en.md) | `host/deploy.py` deployment, operations and backup/restore |
| [docs/ARCHITECTURE.en.md](docs/ARCHITECTURE.en.md) | Full technical architecture and directory layout |
| [docs/PATCHING_WORKFLOW.en.md](docs/PATCHING_WORKFLOW.en.md) | Patch baselines and maintenance workflow |
| [docs/REBRAND_COMPAT.md](docs/REBRAND_COMPAT.md) | Rename registry and migration from older setups |
| [tests/e2e/README.md](tests/e2e/README.md) | How to run the end-to-end tests |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting and deployment security advice |

## License

<img src="docs/images/icons/scale.svg" width="22" height="22" alt="" /> RokBot is licensed under the [RokBot Noncommercial License 1.0](LICENSE): personal use, self-hosting, study, modification and noncommercial redistribution are permitted, and all commercial use is prohibited. Portions derived from ProkBot also remain under the [ProkBot Noncommercial License 1.0](LICENSES/ProkBot-Noncommercial-1.0.txt). See [NOTICE](NOTICE) for derivation and third-party notices, and [docs/faq.en.md](docs/faq.en.md#distribution--compliance) for compliance notes.

## Acknowledgements

RokBot builds on [ProkBot](https://gitee.com/ahaduoduoduo/ProkBot) and [ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus), and drew on `rakazo`'s work on self-hosted deployment. Our thanks to all of them. Friends: [LINUX DO](https://linux.do).

## Disclaimer

RokBot is an independent open-source project and is not affiliated with or endorsed by xAI, official Grok Bot, or Cursor / Anysphere; Grok, Grok Bot and related names and marks belong to their respective owners. Please report security issues privately via [SECURITY.md](SECURITY.md).
