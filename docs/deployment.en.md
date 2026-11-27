# Deployment Guide

[Back to Home](../README.en.md) · [简体中文](deployment.md) · [Getting the Clients](clients.en.md) · [AI Agent Deploy Runbook](AGENT_DEPLOY.en.md) · [Operations & Backup](AI-INSTALL.en.md)

RokBot is a self-hosted AI assistant for personal use. The agent server (the Host) and the Bot's desktop (`box`) run in Docker on your own machine, and model calls go to the OpenAI- or Anthropic-compatible endpoints you configure. The macOS, Windows, Linux, Android and iOS clients and the web client connect only to your Host. Conversations, files, settings and API keys stay on the Host's data volumes.

## 1. Deploy the Host and the execution container

You need a Linux or macOS server with Docker (including Compose v2). This repository is private, so anonymous requests to `raw.githubusercontent.com` fail. Clone the repository first (access required), then run the install script locally:

```bash
# Clone the repository; if you are signed in to the GitHub CLI you can use gh
gh repo clone hongfaqiu/rokbot rokbot-src
# Without gh, use git: git clone https://github.com/hongfaqiu/rokbot.git rokbot-src

mkdir rokbot && cd rokbot
bash ../rokbot-src/host/release/install-images.sh --local
```

`--local` makes the script copy `docker-compose.images.yml` and `.env.images.example` from the repository instead of downloading them. The prebuilt images also require access, so sign in to GHCR before pulling, with a token that has the `read:packages` scope:

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub username> --password-stdin
```

If you cannot pull the images, build them from source on the server instead; see [`docs/AI-INSTALL.en.md`](AI-INSTALL.en.md).

The script does the following, in order:

1. Creates `.env` (mode 0600) with random secrets.
2. Pulls the images.
3. Starts the Host and `box` containers.
4. Waits for the health checks to pass, if your Compose version supports it.
5. Prints the admin console and web client addresses.

> [!TIP]
> - **Let an AI agent deploy it:** give [`docs/AGENT_DEPLOY.en.md`](AGENT_DEPLOY.en.md) to an AI coding assistant such as Claude Code, Cursor or Codex. It will run the environment checks, the deployment and the acceptance steps from the runbook.
> - **Common options:**
>   - The command above already passes `--local`. Without it, the script downloads the templates from `raw.githubusercontent.com`, which fails anonymously for a private repository.
>   - To edit the configuration before starting, use `--prepare-only`, then run the command again without it (keep `--local`).
>   - For an offline install, import the images with `docker load` first and then use `--offline`.
> - **Mirrors and proxies:** set `ROKBOT_HOST_IMAGE` / `ROKBOT_BOX_IMAGE` in `.env` to use a mirror, or set `HTTP_PROXY` / `HTTPS_PROXY`.

## 2. Initialize the Host and connect a client

1. Get the one-time setup key:
   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
   ```
2. Open the admin console at `http://127.0.0.1:18080/admin`, enter the setup key and set an admin password (12–128 characters).
3. Connect a client:
   - **Native clients:** first get a client as described in [Getting the clients](clients.en.md#getting-the-clients). Create a 6-digit pairing code under Devices & notifications in the admin console. Then enter the Host address and the code in the macOS, Windows, Linux, Android or iOS client. You can also sign in with the admin password.
   - **Web client:** enabled by default at `http://127.0.0.1:18081/web/`. The prebuilt images do not include the web client bundle. Before first use, build the bundle as described in [`web/README.en.md`](../web/README.en.md) and upload it on the Web client page of the admin console.

## 3. Configure models

Open the Chat model page of the admin console (`/admin?view=model`), or the settings of a client paired with the admin password:

1. Add a model service: choose the API format (OpenAI Chat, OpenAI Responses or Anthropic), then enter the base URL and API key.
2. Fetch the model list, create a model profile and test the connection.
3. Set the default route. If needed, give individual Bots or the 6 scenarios their own routes and fallbacks.

Once saved, you can create Bots and start chatting.

## Further operations

- Runbook for AI coding assistants (preflight checks, prebuilt images, source builds, releases and troubleshooting): [`docs/AGENT_DEPLOY.en.md`](AGENT_DEPLOY.en.md)
- Source deployments with `host/deploy.py`, split deployments, and volume backup & recovery: [`docs/AI-INSTALL.en.md`](AI-INSTALL.en.md)
- Remote access, LAN connectivity, and backup FAQ: [`docs/faq.en.md`](faq.en.md)
- Security advice and vulnerability reporting: [`SECURITY.md`](../SECURITY.md)
