# 9Router (yandy-r)

A self-hosted AI routing gateway: one OpenAI-compatible endpoint (`/v1/*`) in front of
40+ upstream providers, with format translation, model-combo fallback, multi-account
rotation, OAuth credential management and usage tracking, plus a Next.js dashboard.

> This is a personal copy of [9Router](https://github.com/decolua/9router) by
> [decolua](https://github.com/decolua) and contributors, used under the MIT License.

## What's different here

- **Claude Code client fingerprint is configurable.** The identity sent on `claude`
  (OAuth) traffic defaults to Claude Code 2.1.280 — captured from a real client — and
  can be bumped with env vars instead of a code change (see [Configuration](#configuration)).
- **No OAuth client credentials in source.** The Gemini / Gemini CLI and Antigravity
  OAuth clients are read from env; history was rewritten to remove the committed values.
- **Images are built from GitHub releases** and published to GHCR
  (see [Releases and images](#releases-and-images)).

## Quick start (Docker)

```bash
docker run -d --name 9router \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e JWT_SECRET="$(openssl rand -hex 32)" \
  -e INITIAL_PASSWORD="change-me" \
  ghcr.io/yandy-r/9router:latest
```

- Dashboard: <http://localhost:20128/dashboard> (log in with `INITIAL_PASSWORD`)
- OpenAI-compatible API: `http://localhost:20128/v1`

Or with Compose, pinned to a release:

```yaml
services:
  9router:
    image: ghcr.io/yandy-r/9router:1.0.0   # or :latest
    restart: unless-stopped
    ports:
      - "20128:20128"
    volumes:
      - 9router-data:/app/data
    env_file: .env

volumes:
  9router-data:
```

State (SQLite at `/app/data/db/data.sqlite`) lives in the mounted volume.

## Using it

1. In the dashboard, connect providers (**Providers**) and create an API key (**Endpoint**).
2. Point your client at the gateway:
   - **OpenAI-compatible tools** (Codex, Cursor, Cline, Continue, …): base URL
     `http://localhost:20128/v1`, API key from the dashboard.
   - **Claude Code** and other supported CLIs: **Dashboard → CLI Tools** writes their
     settings for you.
3. Address models as `<provider-alias>/<model>` (e.g. `cc/claude-sonnet-5`) or by a
   combo name. Combos (**Combos**) chain models so requests fall through to the next
   one when a provider is rate-limited, out of quota or failing.

```bash
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer $NINEROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "cc/claude-sonnet-5", "messages": [{"role": "user", "content": "hi"}]}'
```

`GET /v1/models` lists every model and combo available to the key.

## Configuration

The full env contract is in [`.env.example`](.env.example). `.env` is not baked into the
image; pass it with `--env-file` / `env_file`.

| Variable | Default | Notes |
| --- | --- | --- |
| `JWT_SECRET` | generated | Dashboard session signing secret. Set it explicitly. |
| `INITIAL_PASSWORD` | `123456` | First dashboard login. **Override it.** |
| `DATA_DIR` | `/app/data` (image) | SQLite database and backups. |
| `PORT` / `HOSTNAME` | `20128` / `0.0.0.0` (image) | Listen address. |
| `REQUIRE_API_KEY` | `false` | Enforce an API key on `/v1/*`. Enable for any non-local deploy. |
| `AUTH_COOKIE_SECURE` | `false` | Set `true` behind an HTTPS reverse proxy. |
| `API_KEY_SECRET`, `MACHINE_ID_SALT` | built-in | Secrets for generated API keys / machine IDs. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` | — | Outbound proxy for upstream calls. |

**Claude Code fingerprint** — these ship together in each Claude Code release; bump them
as a set. A malformed value fails startup rather than sending an impossible fingerprint.

| Variable | Default | Sent as |
| --- | --- | --- |
| `CLAUDE_CLI_VERSION` | `2.1.280` | `User-Agent: claude-cli/<v>` and billing `cc_version` |
| `CLAUDE_CLI_SDK_VERSION` | `0.112.1` | `X-Stainless-Package-Version` |
| `CLAUDE_CLI_RUNTIME_VERSION` | `v26.3.0` | `X-Stainless-Runtime-Version` |
| `CLAUDE_CLI_BETA_FLAGS` | see `open-sse/config/claudeCliFingerprint.js` | `Anthropic-Beta` base list (comma-separated) |

**Google OAuth clients** — required only for OAuth login and token refresh on these
providers; use the public client values shipped with Gemini CLI / Antigravity IDE.
Without them, login fails with an error naming the missing variables.

| Variables | Providers |
| --- | --- |
| `GEMINI_OAUTH_CLIENT_ID`, `GEMINI_OAUTH_CLIENT_SECRET` | `gemini`, `gemini-cli` |
| `ANTIGRAVITY_OAUTH_CLIENT_ID`, `ANTIGRAVITY_OAUTH_CLIENT_SECRET` | `antigravity` |

## Releases and images

Publishing a GitHub release runs [`docker-publish.yml`](.github/workflows/docker-publish.yml),
which builds `linux/amd64` + `linux/arm64` and pushes to `ghcr.io/yandy-r/9router`:

| Tag | When |
| --- | --- |
| `:1.2.3`, `:1.2` | From the release tag `v1.2.3` |
| `:latest` | Only when the release is the repo's **Latest release** (GitHub's label), so prereleases never move it. When publishing an older-version backport from the web UI, untick "Set as the latest release"; `gh release create` decides by date and version on its own |
| `:sha-<commit>` | Every build |

```bash
gh release create v1.2.3 --generate-notes      # builds and publishes the image
```

The workflow can also be run manually (**Actions → Docker Image → Run workflow**) to
build any branch; it only pushes when the `push` input is checked, and never tags
`:latest`.

## Development

```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev
```

Production build: `npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start`.
Local image: `docker build -t 9router-local .` (pass `--build-arg APK_MIRROR=dl-cdn.alpinelinux.org
--build-arg NPM_REGISTRY=https://registry.npmjs.org` to skip the default CN mirrors).

Tests live in `tests/` as a separate package:

```bash
npm install && (cd tests && npm install)
cd tests && npx vitest run
```

The suite is not all-green on a plain checkout (live-provider and environment-dependent
tests fail); compare against the same run on `master` rather than expecting zero failures.

Architecture notes: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (system overview) and
[`open-sse/AGENTS.md`](open-sse/AGENTS.md) (routing/translation engine conventions).

### Pulling in upstream changes

History here was rewritten, so it no longer shares commits with upstream. Bring fixes over
with cherry-picks:

```bash
git remote add upstream https://github.com/decolua/9router.git   # once
git fetch upstream
git cherry-pick <upstream-commit>
```

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2024-2026 decolua and contributors.
