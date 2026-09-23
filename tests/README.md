# 9Router Tests

Vitest suite for the gateway (`src/`) and routing engine (`open-sse/`). `tests/` is an independent ESM package and is not wired into the root `npm test`.

## Setup

Tests import from `src/`, so install root dependencies first, then the test package's own:

```bash
npm install                 # from the repo root
cd tests && npm install
```

## Running

From the `tests/` directory:

```bash
npx vitest run                           # whole suite
npx vitest run unit/capabilities.test.js # single file (path relative to tests/)
```

`npm test` runs the same thing with `--reporter=verbose`.

## Data isolation

Tests never read or write your real `~/.9router`. Two setup hooks in `vitest.config.js` handle it:

- `setup/tempRoot.js` (`globalSetup`) records your real home in `NINEROUTER_TEST_REAL_HOME`, creates one parent temp dir (`<os.tmpdir()>/9router-test-XXXX`) and deletes it after the run, even when files are skipped or fail to load.
- `setup/isolateDataDir.js` (`setupFiles`) runs before every test file's imports. It creates a fresh per-file root inside that parent, points `DATA_DIR` at `<root>/data`, and points `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and the `XDG_*` dirs inside `<root>/home`. It uses the `forks` pool, because a worker thread's `os.homedir()` ignores the override, and it throws if the override isn't honored.

You don't need a `DATA_DIR=$(mktemp -d)` prefix. `unit/test-data-isolation.test.js` fails if the resolved data dir or home is outside the temp root.

`vitest.config.js` splits the suite into two projects: `unit` (everything except `translator/real/**`) and `real` (`translator/real/**`). The live tests in `real` need your credentials. They skip isolation and use your real data dir only when their live gate (`RUN_REAL=1` or `RUN_E2E=1`) is set. `unit` stays isolated even then.

```bash
RUN_REAL=1 npx vitest run translator/real/thinking
```

## Regression check

The suite is not all-green on a plain checkout. Compare a run against the known failures in `__baseline__/known-fails.txt` instead of reading raw results:

```bash
npx vitest run --reporter=json --outputFile=results.json; node __baseline__/verify-no-regression.mjs results.json
```

It reports tests (keyed by repo-relative path) and whole-file failures such as load errors, empty suites or throwing hooks (keyed as `<path> :: <file>`) that are not in the baseline. Other `__baseline__/verify-*.mjs` scripts check provider, alias and OAuth URL snapshots. Run them after changing the provider registry or alias logic.

## Embeddings

Unit tests for the `/v1/embeddings` endpoint implementation.

### Test Files

| File | What it tests |
|------|--------------|
| `unit/embeddingsCore.test.js` | `open-sse/handlers/embeddingsCore.js` — core logic: body builder, URL router, headers, handler flow |
| `unit/embeddings.cloud.test.js` | `cloud/src/handlers/embeddings.js` — cloud worker handler: auth, validation, rate limits, CORS. The `cloud/` directory is not in this repo, so this file always fails here. |

### Coverage Summary (59 tests)

#### `embeddingsCore.test.js` (36 tests)
- `buildEmbeddingsBody`: single string, array, encoding_format, default float
- `buildEmbeddingsUrl`: openai, openrouter, openai-compatible-*, unsupported providers
- `buildEmbeddingsHeaders`: per-provider header sets, fallback to accessToken
- `handleEmbeddingsCore` input validation: missing, wrong type, null, empty
- `handleEmbeddingsCore` success: response format, CORS, Content-Type, callbacks
- `handleEmbeddingsCore` errors: 400/429/500, network error, invalid JSON
- `handleEmbeddingsCore` token refresh: 401 retry, graceful fallback

#### `embeddings.cloud.test.js` (23 tests)
- CORS OPTIONS: 200 response, empty body, correct headers
- Authentication: missing key, bad format, old-format key, wrong key value, valid key
- Body validation: invalid JSON, missing model, missing input, bad model
- Happy path: single string, array, correct delegation, CORS header, machineId override
- Rate limiting: all accounts rate-limited → 503 + Retry-After, no credentials → 400
- Error propagation: non-fallback errors passed through, 429 exhausts accounts
- machineId override: validates key, rejects wrong key
