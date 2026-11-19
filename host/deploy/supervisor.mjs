import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSelfHostServer } from "../server/index.mjs";
import { internalCredential } from "./credentials.mjs";
import { HostSupervisor } from "./host-supervisor.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
// Primary ROKBOT_* env vars with GROKBOT_* fallback for smooth .env migration.
const data = resolve(process.env.ROKBOT_DATA_DIR ?? process.env.GROKBOT_DATA_DIR ?? "/data");
const state = resolve(process.env.ROKBOT_STATE_DIR ?? process.env.GROKBOT_STATE_DIR ?? join(data, "runtime"));
const modelFile = resolve(
  process.env.ROKBOT_MODEL_ENV ?? process.env.GROKBOT_MODEL_ENV ?? join(data, "model.env"),
);
const tokenFile = resolve(
  process.env.ROKBOT_INTERNAL_HOST_TOKEN_FILE ??
    process.env.GROKBOT_INTERNAL_HOST_TOKEN_FILE ??
    join(data, "internal-host-token"),
);
const hostUrl =
  process.env.ROKBOT_INTERNAL_HOST_URL ??
  process.env.GROKBOT_INTERNAL_HOST_URL ??
  `http://127.0.0.1:${process.env.ROKBOT_HOST_PORT ?? process.env.GROKBOT_HOST_PORT ?? 1340}`;
const publicPort = process.env.ROKBOT_PORT ?? process.env.GROKBOT_PORT ?? 8000;
Object.assign(process.env, {
  ROKBOT_DATA_DIR: data,
  ROKBOT_STATE_DIR: state,
  ROKBOT_MODEL_ENV: modelFile,
  ROKBOT_INTERNAL_HOST_TOKEN_FILE: tokenFile,
  ROKBOT_HOST_DATA_DIR: join(state, "host-data"),
  ROKBOT_INTERNAL_HOST_URL: hostUrl,
  ROKBOT_CONNECTORS_URL:
    process.env.ROKBOT_CONNECTORS_URL ??
    process.env.GROKBOT_CONNECTORS_URL ??
    `http://127.0.0.1:${publicPort}/internal/connectors`,
  ROKBOT_SPEECH_URL:
    process.env.ROKBOT_SPEECH_URL ??
    process.env.GROKBOT_SPEECH_URL ??
    `http://127.0.0.1:${publicPort}/internal/audio/transcriptions`,
  ROKBOT_NATIVE_DESKTOP_URL: `http://127.0.0.1:${publicPort}/internal/desktop-capabilities`,
  ROKBOT_HOST_BIND: process.env.ROKBOT_HOST_BIND ?? process.env.GROKBOT_HOST_BIND ?? "127.0.0.1",
});
await mkdir(data, { recursive: true, mode: 0o700 });
await mkdir(state, { recursive: true, mode: 0o700 });
const internalToken = await internalCredential(tokenFile, { create: true });
// Only image-owned generated files are refreshed. User data and credentials never come from the image.
for (const entry of [
  "blob-worker-library-provenance.json",
  "blob-worker-library.cjs",
  "host-library-provenance.json",
  "host-library.cjs",
  "recovered-core",
  "recovered-worker",
]) {
  await cp(join(root, "seed", entry), join(state, entry), {
    recursive: true,
    force: true,
  });
}
let supervisor;
const service = await createSelfHostServer({
  computers: () => supervisor?.getComputers() ?? { available: false, computers: [] },
});
const address = await service.start();
console.log(
  `[supervisor] administration listening on ${address.port}${service.auth.initialized ? "" : `; initialization key file: ${join(data, "setup-key")}`}`,
);
supervisor = new HostSupervisor({
  dataDir: data,
  hostUrl,
  internalToken,
  entry: join(root, "runtime/host.mjs"),
  env: process.env,
  isConfigured: async () => {
    const model = await service.models.current();
    return Boolean(model.baseUrl && model.apiKey && model.model) &&
      ((process.env.ROKBOT_REQUIRE_EXECUTION_NODE ?? process.env.GROKBOT_REQUIRE_EXECUTION_NODE) !== '1' || service.executionNode.store.value.config.enabled);
  },
}).start();
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.stop();
    await service.close();
  });
