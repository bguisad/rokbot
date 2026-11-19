# RokBot Mac Patch

[简体中文](README.md)

Build RokBot from the official Grok Bot 0.71.2 for Apple Silicon client and connect it to your RokBot Host. Requires Node.js 22.12+.

The complete deployment steps are in the [deployment guide](../docs/AI-INSTALL.en.md#client-packages), and how it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#mac-client). `clients/desktop/` is the client's main process; the Windows and Android clients use its code too.

## Use

```sh
node patchers/desktop/patch.mjs
```

Automatically downloads and verifies the 0.71.2 Apple Silicon original, applies the RokBot application icons (`assets/logo/rokbot.icns` and `assets/logo/rokbot-icon-512.png`), and generates `output.noindex/RokBot.app`. Move it into Applications and enter your Host address and 6-character pairing code.

To fetch the original installer from a mirror, set `ROKBOT_DESKTOP_DOWNLOAD_BASE` (a credential-free `http(s)` base URL); downloaded bytes are still strictly verified against the pinned byte length and SHA-256 digest.

The official Mac app has moved to 1.2.3 (checked November 19, 2026), but this patch stays on 0.71.2: the Mac app is a separate package that needs its own patch and testing of installation, signing and local graphical control on a Mac, which the maintainers don't have. 0.71.2 can still be downloaded from the official address, and the patcher checks its full digest.

To use an existing `.app` or `.dmg`, add `--source "/path/to/Grok Bot.app"`.

`--verify-only` replays the fixed recipes in temporary storage without building a client. A supplied DMG must match the full archive SHA-256, and the Mac tool verifies the input app's signature. This project has not tested installation, launch, pairing or chat on macOS. See the [version table](../README.en.md#client-versions) for accepted inputs and the latest official releases.

For local graphical control, add `--identity auto` to sign with an existing certificate.

Repository: <https://github.com/hongfaqiu/rokbot>

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
