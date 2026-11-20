# RokBot Opaque-Box E2E Test Suite

Requirement-driven, zero-dependency Node.js (`v24+`) end-to-end test suite verifying RokBot's Host HTTP/SSE control plane, pairing & device deduplication, in-app model configuration, 4-platform incremental auto-updates (`RBDELTA1` / `RBD1` + ECDSA P-256 + iOS OTA), deformed Logo assets, Category-A/B rebranding, one-click image deployment, and secret hygiene.

## Directory Layout

- `tests/e2e/runner.mjs` — CLI entrypoint, tier module discovery, lifecycle & report auditing (`rokbot-e2e-report/v1`)
- `tests/e2e/lib/harness-server.mjs` — Self-contained reference Host (`E2EReferenceHost`) on `127.0.0.1:0`
- `tests/e2e/lib/client.mjs` — Opaque-box HTTP/Cookie/Bearer/SSE client (`RokBotE2EClient`)
- `tests/e2e/lib/crypto-delta.mjs` — ECDSA P-256 signing, `RBDELTA1`/`GBDELTA1`, `RBD1`/`GBD1`, ASAR/ZIP builders, iOS `manifest.plist` & `altstore.json`
- `tests/e2e/lib/repo-checks.mjs` — Category-A/B rebranding scanner, PNG/ICO/ICNS/SVG inspectors, `install-images.sh --prepare-only` runner, `assertNoSecrets`
- `tests/e2e/tiers/tier[1-4]-*.test.mjs` — Modular Tier 1–4 test suites (`tier`, `name`, `registerTests(test, ctx)`)

## Quick Start

```bash
# 1. Verify S1 runner, harness, crypto-delta & repo-checks end-to-end
node tests/e2e/runner.mjs --self-check

# 2. Run all E2E tiers against the isolated reference harness (default mode)
node tests/e2e/runner.mjs

# 3. Run a specific tier with JSON output or substring filter
node tests/e2e/runner.mjs --tier 1 --json
node tests/e2e/runner.mjs --tier 1,2 --filter F05

# 4. Run against a live integrated RokBot Host + repository checks
ROKBOT_E2E_HOST_URL=http://127.0.0.1:18080 \
ROKBOT_E2E_ADMIN_PASSWORD=your-admin-password \
node tests/e2e/runner.mjs --mode live --repo-check
```

## CLI Flags

| Flag | Description |
|---|---|
| `--tier <1\|2\|3\|4\|all>` | Tier(s) to execute (supports comma-separated list like `1,2`; default: `all`) |
| `--mode <harness\|live>` | Execution mode (`live` automatically selected when `ROKBOT_E2E_HOST_URL` is set, otherwise `harness`) |
| `--repo-check` | Enable strict repository-wide asset, rebranding, and `install-images.sh` checks |
| `--json` | Emit single `rokbot-e2e-report/v1` JSON report to `stdout` |
| `--filter <substring>` | Case-insensitive filter matching test `id`, `title`, or suite `name` |
| `--self-check` | Run built-in S1 smoke checks even when `tests/e2e/tiers/` is empty |
| `--help` | Print CLI help |

## Environment Variables

| Variable | Purpose |
|---|---|
| `ROKBOT_E2E_HOST_URL` | Target Host base URL (selects `--mode live` automatically) |
| `ROKBOT_E2E_ADMIN_PASSWORD` | Admin password for live Host authentication & step-up tests |
| `ROKBOT_E2E_PAIRING_KEY` | Optional pre-generated pairing key for live mode |
| `ROKBOT_E2E_DEVICE_TOKEN` | Optional pre-paired device Bearer token for live mode |
| `ROKBOT_E2E_REPO_CHECK=1` | Equivalent to `--repo-check` |

## Tier Module Contract

Every file matching `tests/e2e/tiers/tier([1-4])-.*\.test\.mjs` must export:

```js
export const tier = 1; // 1 | 2 | 3 | 4
export const name = 'feature-suite-name';

export function registerTests(test, ctx) {
  test('T1-F05-01', 'descriptive test title', async (t) => {
    const client = ctx.createClient();
    t.after(() => client.close());
    const tmpDir = await t.createTempDir('case-');
    // ...
  });
}
```

- **`ctx` fields**: `mode`, `repoCheck`, `repoRoot`, `baseUrl`, `adminPassword`, `pairingKey`, `deviceToken`, `createClient(opts?)`, `createTempDir(prefix?)`, `cryptoDelta`, `repoChecks`, `harness` (`null` in `live` mode), `assert` (`node:assert/strict` + `assertStatus`, `assertJsonSchema`, `assertNoSecrets`).
- **Skip rule**: In default `harness` mode, all tests must pass with `0` failures and `0` skips. `t.skip(reason)` is reserved strictly for `live`-mode constraints that cannot inject harness-only faults.

## Client SSE Cursor (`openSse`)

`client.openSse(path, opts)` automatically forwards cookies (plus `x-rokbot-web: 1` for `rokbot_web` sessions unless `webHeader: false` or Bearer token is active) and exposes:
- `sse.events` — full array of all received SSE events in arrival order.
- `sse.nextEvent(predicate, timeoutMs, { consume = true } = {})` — searches from an internal `readIndex` cursor and, by default (`consume: true`), advances `readIndex` past the matched event so sequential `nextEvent()` calls consume events in order without re-matching earlier events. Pass `{ consume: false }` to peek without advancing `readIndex`.
- `sse.close()` — aborts and closes the stream cleanly.

## JSON Output & Exit Codes

`--json` emits schema `rokbot-e2e-report/v1`:

```json
{
  "schema": "rokbot-e2e-report/v1",
  "ok": true,
  "mode": "harness",
  "repoCheck": false,
  "selfCheck": false,
  "durationMs": 120,
  "summary": { "total": 174, "passed": 174, "failed": 0, "skipped": 0 },
  "tiers": { "1": { "total": 75, "passed": 75, "failed": 0, "skipped": 0 } },
  "results": []
}
```

Exit codes:
- `0` — Zero failures AND (`--self-check` passed, or all requested unfiltered tiers executed `> 0` tests).
- `1` — Any test failure, secret-hygiene violation in report, or empty requested tier.
- `2` — Invalid CLI arguments or `--mode live` without `ROKBOT_E2E_HOST_URL`.
