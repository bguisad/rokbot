# RokBot Mac Patch

[简体中文](README.md)

Build RokBot from the official Grok Bot 1.2.3 for Apple Silicon client and connect it to your RokBot Host. Requires Node.js 22.12+.

The complete deployment steps are in the [deployment guide](../docs/AI-INSTALL.en.md#client-packages), and how it works is in the [technical documentation](../docs/ARCHITECTURE.en.md#mac-client). `clients/desktop/` is the client's main process; the Windows and Android clients use its code too.

## Use

Run on macOS from the `mac/` directory (from the repository root, use `node mac/patchers/desktop/patch.mjs`):

```sh
node patchers/desktop/patch.mjs --source "/path/to/Grok_Bot_1.2.3.dmg"
```

The tool verifies the 1.2.3 Apple Silicon original (without `--source` it downloads it from the official address and verifies it), applies the RokBot application icons (`assets/logo/rokbot.icns` and `assets/logo/rokbot-icon-512.png`), and generates `output.noindex/RokBot.app`, keeping a copy of the original in `backup.noindex/RokBot.app`. An existing output is never overwritten. Move it into Applications and enter your Host address and 6-character pairing code.

To fetch the original installer from a mirror, set `ROKBOT_DESKTOP_DOWNLOAD_BASE` (a credential-free `http(s)` base URL); downloaded bytes are still strictly verified against the pinned byte length and SHA-256 digest.

The patch accepts only the unmodified 1.2.3 Apple Silicon original; the pinned digests are in [`patchers/desktop/supported.json`](patchers/desktop/supported.json). `--source` can also point to an existing `Grok Bot.app`.

`--verify-only` replays the fixed recipes in temporary storage without building a client. A supplied DMG must match the full archive SHA-256, and the Mac tool verifies the input app's signature. This project has not tested installation, launch, pairing or chat on macOS. See [Supported Platforms](../docs/clients.en.md#supported-platforms) for accepted inputs.

The app is ad-hoc signed by default. For local graphical control, add `--identity auto` to sign with an existing Developer ID Application or Apple Development certificate from your keychain.

This repository does not provide original or generated clients. Use the generated app only on your own devices, or have your Host administrator publish it on the Client updates page; see [Getting the clients](../docs/clients.en.md#getting-the-clients).

Repository: <https://github.com/hongfaqiu/rokbot>

## License and support

Noncommercial use only. See [LICENSE](LICENSE). Most of this project's code was written with AI assistance.
