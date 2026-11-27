# FAQ & Compliance

[Back to Home](../README.en.md) · [简体中文](faq.md) · [Deployment Guide](deployment.en.md) · [Getting the Clients](clients.en.md) · [Security Policy](../SECURITY.md)

## FAQ

**How do I reach the Host without a public IP?**

Turn on the built-in Tailcat on the Remote access page; no Tailscale account is needed. Tailscale, a VPN or an HTTPS reverse proxy also work. The web client does not support Tailcat, so use a VPN or an HTTPS domain to reach it remotely. Do not expose the admin console directly to the internet; see [`SECURITY.md`](../SECURITY.md).

**Why can't my phone reach the Host on the LAN?**

`ROKBOT_LISTEN_ADDRESS` defaults to `127.0.0.1`, which only allows connections from the server itself. For LAN use, set it to the server's LAN IP, or to `0.0.0.0` behind a firewall. Note that ports published by Docker bypass host firewalls such as ufw.

**Can I deploy on an ARM server?**

Yes. The Host image supports `linux/arm64`. The `box` desktop image is `linux/amd64` only, so enable binfmt/QEMU on the host, or Rosetta on Apple Silicon.

**Why are there no client installers in the repository?**

This repository distributes only the code and documentation this project wrote itself. It contains no original program files and offers no patched installers. You can bring your own official installer and build the client on your machine with the patch tools, or get it from the administrator of your own Host, who publishes it on the Client updates page. Both methods are described in [Getting the clients](clients.en.md#getting-the-clients), and the reasons in [Distribution & compliance](#distribution--compliance) below.

**Where are API keys stored, and can they be read back?**

API keys are stored in `/data/model.env` on the Host data volume. The admin API and the clients only see whether a key is set, never the key itself.

**How do I back up my data?**

Data lives in three volumes: `host-data` (mounted at `/data`), `box-home` and `box-workspace`. With a `host/deploy.py` deployment, run `python3 host/deploy.py backup`. For recovery, see [`docs/AI-INSTALL.en.md`](AI-INSTALL.en.md#volume-recovery). Backups contain conversations and keys, so keep them safe. Do not run `docker compose down -v`, which deletes the volumes.

## Distribution & compliance

- This project does not distribute binaries of third-party clients. The repository contains only what this project wrote itself: the Host source, image build scripts, patch tools, build scripts and documentation. Users obtain the original installers themselves.
- RokBot is licensed under the [ProkBot Noncommercial License 1.0](../LICENSE). It permits personal use, self-hosting, study, modification and noncommercial redistribution. All commercial use is prohibited, including:
  - selling or licensing it for payment;
  - paid hosting or paid services;
  - incorporating it into commercial products;
  - a business's internal operations;
  - monetizing it through advertising or similar means.

  The [LICENSE](../LICENSE) file is authoritative. See [NOTICE](../NOTICE) for derivation and third-party components.
- The patch tools are provided for personal study and self-hosting only. The noncommercial redistribution permitted by the [LICENSE](../LICENSE) covers only this project's own code, not any part of the original programs.
- When you use the original clients and the patches, comply with the original client's license terms and the applicable terms of service.
- Do not distribute publicly the clients, web client bundles or images with a built-in bundle that you generate with the patch tools; use them only with your own Host. When installers are distributed through a Host, the administrator of that Host is responsible for the channel and for who receives them.
- This section is not legal advice. Whether a particular use is permitted depends on the original client's license terms and the laws where you live.
