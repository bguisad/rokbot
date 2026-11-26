# RokBot Linux Desktop Client

[中文](README.md)

Locally patches the official **Grok Bot Linux `.deb` (1.3.0)** into a self-hosted **RokBot Linux desktop client** for **x64 (`amd64`)** and **arm64 (`aarch64`)**, producing a portable directory, `.tar.gz`, and `.deb` package.

## Highlights

- Shares the `mac/clients/desktop/` runtime and full RokBot feature set with macOS and Windows (self-hosted redirection, telemetry disabled, in-app model config, `needsModel` banner, session list arrangement, avatar styles, usage charts, batch image download, Tailcat tunneling, and `rokbot-local://` deep links).
- Rebranded as `rokbot-local`: installs to `/opt/RokBot/rokbot`, `/usr/bin/rokbot`, `/usr/share/applications/rokbot.desktop`, hicolor icons, and `/etc/apparmor.d/rokbot`.
- Strips upstream's `postinst` registration of `downloads.cursor.com/aptrepo` and GPG keys.
- Bundles prebuilt Linux `rokbot-tailcat` binaries (`host/bin/rokbot-tailcat` and `host/bin/linux-arm64/rokbot-tailcat`).
- Supports self-hosted updates via Host (`/local/updates/linux-x64.json`, `/local/updates/linux-arm64.json`) and in-place ASAR delta swaps for writable portable installs.

## Build

Install the shared `@electron/asar` dependency first:

```bash
npm install --prefix mac/patchers/desktop
```

```bash
# Verify official package and recipes only
node linux/patchers/desktop/patch.mjs --arch x64 --verify-only
node linux/patchers/desktop/patch.mjs --arch arm64 --verify-only

# Build portable directory, .tar.gz, and .deb (works on Linux and macOS without dpkg-deb)
node linux/patchers/desktop/patch.mjs --arch x64
node linux/patchers/desktop/patch.mjs --arch arm64

# Use a local official .deb (architecture and version detected by SHA-256)
node linux/patchers/desktop/patch.mjs --source /path/to/grok-bot_1.3.0_amd64.deb
```

Outputs are written to `linux/output/`:
- `RokBotLocal-1.3.0-linux-<arch>/`
- `RokBotLocal-1.3.0-linux-<arch>.tar.gz`
- `RokBotLocal-1.3.0-linux-<arch>.deb`
- `RokBotLocal-1.3.0-linux-<arch>.patch.json`
