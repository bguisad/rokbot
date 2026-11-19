# RokBot

**Self-hosted RokBot server with your own models, committed to native official client patching across platforms.**

[简体中文](README.md) · **English** · [Rebranding & Compatibility](docs/REBRAND_COMPAT.md)

---

## Overview

RokBot is a self-hosted AI assistant runtime and official native client patching toolkit:

- **Native Clients First (No WebView Wrapper)**: Drops the legacy Android WebView wrapper that embedded the Windows UI. Instead, `android/` directly patches the official React Native + Hermes Android `.xapk` / `.apks` / `.apk`, preserving the authentic native interface and interactions.
- **Enhanced Self-Hosted Host**: Supports Anthropic Messages, OpenAI Responses, and OpenAI Chat APIs, per-Bot model routing, reliable context compaction, admin-password pairing, multi-machine local execution, and deterministic default machine pinning (`ROKBOT_DEFAULT_MACHINE_ID`).
- **Clean Distribution**: Contains no official binaries, pre-patched APKs/IPAs, or private keys. Every client and Host image is assembled locally from verified official packages.

---

## Credits & Upstream References

RokBot builds on ideas, patch mechanisms, and architecture learned from two upstream open-source projects:

1. **[ProkBot](https://gitee.com/ahaduoduoduo/ProkBot)** (baseline `3e9fe8c`) — pioneered containerizing the Host and patching official clients for self-hosting;
2. **[ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus)** (referenced through `1.5.1`) — added multi-provider model APIs, per-Bot routing, reliable compaction, Windows/Web clients, and deployment tooling.

RokBot starts fresh as an independent repository focused on **native official client patching** and advancing to the **latest Host bundle baseline**. It remains under the [ProkBot Noncommercial License 1.0](LICENSE) (see [NOTICE](NOTICE)).

---

## Repository Layout

| Directory | Description | Current Target Baseline |
| --- | --- | --- |
| [`host/`](host/) | Self-hosted Host runtime, admin server, Docker build & byte-patch recipes | Host `d0a4baa` / Box `9d2ac1b` (`2bb5e41` upgrade planned) |
| [`android/`](android/) | **Native React Native Android patcher** (Split XAPK merger, Pairip neutralization, Hermes bytecode patches, Companion DEX, 16KB-aligned Tailcat `.so`, 6 native modals) | Official Android `1.16.0` (build `1075`) |
| [`windows/`](windows/) | Windows x64 client patcher & installer | Official Windows `1.1.0` (also `0.71.2`) |
| [`mac/`](mac/) | macOS Apple Silicon client patcher | Official macOS `0.71.2` |
| [`ios/`](ios/) | iOS arm64 decrypted IPA patcher (native dylib injection) | Official iOS `1.16.0` (build `23152`) |
| [`web/`](web/) | Browser web client bundler & uploader | UI from Windows `1.1.0` |
| [`docs/`](docs/) | Deployment guide, architecture docs, and [rebranding compatibility registry](docs/REBRAND_COMPAT.md) | — |

---

## Quick Start

Repository: <https://github.com/hongfaqiu/rokbot>

```bash
git clone https://github.com/hongfaqiu/rokbot.git
cd rokbot
```

### 1. Deploy the Self-Hosted Host

See [`docs/AI-INSTALL.en.md`](docs/AI-INSTALL.en.md) and [`host/README.en.md`](host/README.en.md):

- Build Host image: `python3 host/release/build-docker.py --host-archive <sand-host-bundle.tgz>`
- Start services: `docker compose -f host/release/compose.yaml up -d`
- Pin a default local-exec computer when multiple desktops are attached via `ROKBOT_DEFAULT_MACHINE_ID`.

### 2. Patch the Native Android Client

See [`android/README.en.md`](android/README.en.md) (requires Node.js >= 20):

```bash
node android/release/patch-android.mjs \
  --input-apk /path/to/grok-bot-1.16.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk \
  --force
```

---

## Roadmap

- [ ] **Host Baseline Upgrade**: Migrate from `d0a4baa` to latest `2bb5e41` (`officekit-ts`, native multi-machine local exec, Local CUA, updated extension registry)
- [ ] **Desktop Client Updates**: Adapt Windows / macOS patchers to official `1.2.x`
- [ ] **Native Android Polish**: Real-device hardening, mobile connector policy, and delta updates

---

## License & Notices

- Licensed under the [ProkBot Noncommercial License 1.0](LICENSE): personal use, study, modification, and noncommercial distribution only; commercial use of any kind is prohibited.
- Unofficial project, not affiliated with xAI, Grok Bot, or Cursor/Anysphere. See [SECURITY.md](SECURITY.md) for vulnerability reporting.
