# YAN-385 UX Research: Cursor browser login (PKCE) + Cursor plan usage

Scope: dashboard UX for (a) a "Login with browser" Cursor connection flow that
works when 9router runs headless or in Docker, with the existing IDE import kept
as a fallback, and (b) Cursor plan usage in the Usage page's Provider Limits
cards. The recommendations target **master's** components (this branch is cut
from master, not the Signal `re-design` branch). The aim is minimal UI churn.

## Executive Summary

- **Reuse what the dashboard already has.** Master already has every visual
  primitive this feature needs:
  - The device-code "Login URL + Copy + Open + spinner" block in
    `src/shared/components/OAuthModal.js` (lines ~896-946).
  - The two-tab "Sign in with browser / Paste token" switch in
    `src/shared/components/ProxyOAuthPanel.js` (`modeTabClass`).
  - The success and error panels at the end of `OAuthModal.js`.
  - The `useCopyToClipboard` hook.

  Cursor login is best built by extending `src/shared/components/CursorAuthModal.js`
  with a browser-login mode that copies those patterns. Routing Cursor through
  the generic `OAuthModal` is a worse fit: its device-code branch always renders
  a "Your Code" box, and Cursor PKCE has no user code.

- **The poll runs on the server; the browser only watches.** The UI calls a
  local start endpoint that returns `{ loginUrl, state, expiresAt }`, shows the
  URL, and polls a local status endpoint. This is the same `poll-status?state=`
  pattern OAuthModal already uses for codex/xai/proxy providers (1.5 s interval,
  about 5 min cap). The PKCE verifier never reaches the browser. The link works
  on any device, which is what makes Docker and headless setups work.
- **Usage fits `QuotaTable` rows with two small additions.** Each Cursor window
  (Total, Auto + Composer, API) becomes a row with `remainingPercentage` and
  `resetAt = billingCycleEnd`. On-demand becomes a dollar row. The gaps on master:
  1. The fetched `plan` is **never rendered** in the Provider Limits card.
     `ProviderLimits/index.js` stores `quotaEntry.plan`, but only the unused
     `ProviderLimitCard.js` draws a plan Badge.
  2. `QuotaTable` can only print `used / total` as bare numbers, so `$` amounts
     and ">100% (bonus)" can't be labelled.

  Proposed fix: a plan Badge in the card header, plus an optional per-row
  `detail` string override in `QuotaTable`.

- **Fail soft.** The usage handler returns `{ message }` and never throws. A
  `message` hides the table (index.js ~1265), so only set it when there are no
  rows. Auth-type messages should contain "expired" or "re-authorize" so the
  usage route's existing force-refresh retry (`AUTH_EXPIRED_PATTERNS`) fires. The
  text should also tell the user how to reconnect.

## User Workflows

### Primary: Login with browser (new, default tab)

1. Providers → Cursor → **Add Connection** (`providers/[id]/page.js`
   `triggerAddConnection`) opens `CursorAuthModal`. The default tab is
   **"Login with browser"**.
2. The modal calls `POST /api/oauth/cursor/authorize` (name TBD). The server
   generates the verifier, challenge and uuid, starts a background poll against
   `api2.cursor.sh/auth/poll`, and returns
   `{ loginUrl: "https://cursor.com/loginDeepControl?challenge=…&uuid=…&mode=login", state, expiresAt }`.
3. The modal shows:
   - Short copy: "Open this link in any browser where you can sign in to Cursor.
     It doesn't have to be this machine."
   - The login URL in a `bg-sidebar` block with **Copy** and **Open** buttons.
     This is a verbatim reuse of the OAuthModal device-code block, without the
     "Your Code" panel.
   - A spinner row: "Waiting for you to approve in Cursor…". Once `expiresAt` is
     known, add a countdown ("expires in 4:12").
   - The modal tries `window.open` once. Popup blockers may stop it after an
     `await`, so the **Open** button stays the main affordance.
4. The user approves on cursor.com. The server poll gets the tokens and saves the
   connection (`authType: "oauth"`, same as `import/route.js`). The status
   endpoint returns `done`. The modal shows the existing success panel
   ("Connected Successfully!" / "Your Cursor account has been connected." /
   **Done**), then `onSuccess` refreshes the connection list.
5. If available, show the account email under the connection name. Existing
   rows already use `getConnectionSecondaryLabel` for this.

### Alternative: Import from Cursor IDE (existing, second tab)

- The second tab is **"Import from Cursor IDE"**. It keeps the current
  `CursorAuthModal` body unchanged: auto-detect on open, "Tokens auto-detected"
  green banner, Windows-manual amber banner with Retry, and the Access Token and
  Machine ID fields.
- Change: auto-detect should run **when this tab is selected**, not whenever the
  modal opens. In Docker or headless setups it always fails and shows "Cursor IDE
  not detected", which is noise on the default path.
- Add one hint line: "Use this if browser login isn't available. Tokens from the
  IDE can't be refreshed automatically." The Cursor executor's
  `refreshCredentials()` returns `null`, so imported tokens simply expire.

### Alternative: Reconnect an expired connection

- There is no "Reconnect" affordance anywhere on master (grep for
  reauth/reconnect finds nothing in providers or shared components). For this
  feature, put the reconnect instruction in text: the usage `message` and the
  connection error should say "Reconnect Cursor from Providers → Cursor".
- **Should-have:** a reconnect button that opens `CursorAuthModal` pre-set to
  the browser tab and updates the same connection (by email or user id) rather
  than creating a duplicate.

### Usage viewing

- Usage → Provider Limits. The Cursor card shows a header with the provider
  icon, "Cursor", the account label, and a plan badge (for example **Ultra**).
- Rows:

  | Row             | Bar | Right-hand %           | Detail text       | Reset       |
  | --------------- | --- | ---------------------- | ----------------- | ----------- |
  | Total           | yes | remaining %            | `37% used`        | billing end |
  | Auto + Composer | yes | remaining %            | `12% used`        | billing end |
  | API             | yes | remaining %            | `97% used`        | billing end |
  | On-demand       | yes | remaining % of $ limit | `$12.40 / $50.00` | billing end |

- The reset column already renders "in 12d 3h" plus "Oct 7, 12:00 AM" from
  `resetAt` (`QuotaTable.formatResetTimeDisplay` / `utils.formatResetTime`).
  Nothing new is needed there.

## UI/UX Best Practices

### Login modal (reuse map)

| Need                                 | Reuse from master                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| Mode switch                          | `modeTabClass()` + two buttons in `ProxyOAuthPanel.js` (use icons, not emoji)      |
| Login URL block, Copy/Open           | `OAuthModal.js` device-code block (`deviceLoginUrl`, `copied === "login_url"`)     |
| Spinner "waiting" row                | `OAuthModal.js` / `ProxyOAuthPanel.js` `progress_activity` rows                    |
| Success / error panels + Try Again   | `OAuthModal.js` `step === "success"` / `step === "error"`                          |
| Poll loop with abort-on-close        | `OAuthModal.js` `poll-status` effect (`POLL_INTERVAL_MS=1500`, `MAX_ATTEMPTS=200`) |
| Clipboard                            | `@/shared/hooks/useCopyToClipboard`                                                |
| Method picker (if tabs are rejected) | `KiroAuthModal.js` method cards (icon + title + one-line description)              |

- **Keep the modal self-contained.** Put the browser flow inside
  `CursorAuthModal.js`, or in a small `CursorBrowserLogin` sub-component if the
  file would pass about 300 lines. Don't add `cursor` to OAuthModal's
  `deviceCodeProviders` list: that branch assumes `user_code` and client-side
  `codeVerifier` polling. Also leave `page.js` routing alone; it already sends
  `providerId === "cursor"` to `CursorAuthModal`.
- **Copy guidance:** use "Login with browser" (matching the ticket) or "Sign in
  with browser" (matching ProxyOAuthPanel). Pick one and use it everywhere.
  Always tell the user the link can be opened on another device. That is the
  headless value proposition, and users of Docker-hosted 9router otherwise assume
  the popup must succeed.
- **Show the URL even when auto-open works.** The dashboard may be viewed on a
  machine that isn't signed in to Cursor, and a visible URL is easy to copy to a
  phone.
- **Don't expose secrets.** The login URL contains only the challenge and uuid,
  which is safe to show. The verifier and tokens must never be returned to the
  client, unlike the current device-code poll, which sends `codeVerifier` from
  the browser.
- **Accessibility:** buttons need text labels (Copy/Open), not just icons. The
  status line should be `aria-live="polite"` so screen readers announce
  "Connected". Focus should move to **Done** on success.

### Usage card

- **Plan badge:** render `quota.plan` next to `providerLabel(conn.provider)` in
  `ProviderLimits/index.js` using `@/shared/components/Badge`. Reuse the
  `planVariants` map (`free/pro/ultra/enterprise`) from `ProviderLimitCard.js`.
  Move it into `utils.js` rather than copying it. Every provider that already
  returns `plan` (Zed, Grok CLI, …) gets the badge too, so this is a small
  cross-provider improvement. Check that it doesn't clutter the Kiro chip row.
- **Percent-only rows:** follow the existing convention and send
  `remainingPercentage = clamp(100 - pctUsed, 0, 100)` with `used = pctUsed`,
  `total = 100` (as Grok's "Weekly SuperGrok" does). Don't forward absolute
  `remaining`, because `getRemainingPercentage` treats it as a percentage. This
  pitfall is already documented in the qoder and grok-cli cases of
  `parseQuotaData`.
- **Dollar rows:** add an optional `detail` (display string) field that
  `QuotaTable` prints instead of `used / total` when present. Format on the
  server in `open-sse/services/usage/cursor.js`, converting cents to
  `$12.40 / $50.00`. This is a minimal, additive change that doesn't touch
  existing providers. Without it the row reads `1240 / 5000`, which is wrong and
  confusing.
- **Row order:** Total → Auto + Composer → API → On-demand. Add a `cursor` case
  to `parseQuotaData` that preserves insertion order. The generic path re-sorts
  by `PROVIDER_MODELS` order, which is meaningless for window names.
- **Colour thresholds:** keep the existing green (>70% remaining), yellow
  (30-70%) and red (<30%) thresholds so Cursor matches other providers. The
  ClaudeBar issue shows that API can sit at 97% while Total is at 50%, which is
  why all three rows must be shown instead of only Total.

## Error Handling

| State                                                       | Where        | Detection                                                 | UX (copy)                                                                                                                                                          |
| ----------------------------------------------------------- | ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login timeout                                               | Login modal  | Server poll deadline reached → status `error` / `expired` | Error panel: "Login link expired. Start again to get a new link." Buttons **Try Again** (new uuid) / **Cancel**.                                                   |
| User closed the cursor.com tab / never approved             | Login modal  | Can't be detected; looks like continued `pending`         | After ~60 s of `pending`, show hint: "Didn't finish? Reopen the link or start over." Keep **Open** / **Copy** visible. Timeout eventually applies.                 |
| User closed the modal mid-flow                              | Login modal  | `isOpen` → false                                          | Abort the client poll and call a cancel endpoint so the server stops polling. A late approval must **not** save a connection (t3code rule).                        |
| Status poll network error                                   | Login modal  | `fetch` throws                                            | Retry silently (current proxy-poll behaviour). After 3 consecutive failures show "Lost contact with 9router, retrying…" instead of failing.                        |
| Upstream poll error (Cursor 4xx/5xx other than pending 404) | Login modal  | Server records `error`                                    | Error panel with the upstream message trimmed to ~200 chars (same approach as grok-cli), plus **Try Again**.                                                       |
| Popup blocked                                               | Login modal  | `window.open` returns null                                | No error; the URL block with Copy/Open is always visible. Optional muted line: "Popup blocked. Use Open or copy the link."                                         |
| Duplicate account                                           | Login modal  | Server matches existing email or user id                  | Update the existing connection and say "Updated existing connection" in the success panel, rather than creating a duplicate.                                       |
| Token refresh failure → reconnect                           | Usage + chat | Refresh returns null / 401 from Cursor                    | Usage message: "Cursor session expired. Please re-authorize: Providers → Cursor → Login with browser." The keywords trigger the route's force-refresh retry first. |
| Imported IDE token expired                                  | Usage + chat | 401, no refresh token                                     | Same message, adding "Imported IDE tokens can't auto-refresh. Use Login with browser."                                                                             |
| Usage endpoint 401                                          | Usage card   | Handler maps to `{ message }`                             | Muted centered text (index.js `quota?.message` branch). No red error icon.                                                                                         |
| Usage endpoint 404                                          | Usage card   | Endpoint moved or plan has no summary                     | `{ message: "Cursor usage unavailable for this account." }`. Keep `plan` if it's known from elsewhere.                                                             |
| Usage endpoint 5xx / timeout / bad JSON                     | Usage card   | Handler catch                                             | `{ message: "Cursor usage unavailable right now (HTTP 503). Try refresh later." }`. Never throw, or the card turns into a red `HTTP 500:` error.                   |
| Percent > 100 (bonus usage)                                 | Usage card   | `totalPercentUsed > 100` or `breakdown.bonus > 0`         | Clamp the bar to 0% remaining (red). Detail text `112% used · bonus` via `detail`. Don't put this in `message`, which would hide the table.                        |
| On-demand disabled                                          | Usage card   | `onDemand.enabled === false`                              | Omit the On-demand row. Optionally add one row "On-demand" with `unlimited`-style text "Off". Recommendation: omit.                                                |
| On-demand enabled, no limit                                 | Usage card   | `limit == null`                                           | Row with `unlimited: true` so QuotaTable prints "`$X used · Unlimited`" (the existing Zed path). Needs `detail` for `$` formatting.                                |
| On-demand limit reached                                     | Usage card   | `used >= limit`                                           | 0% remaining, red, detail `$50.00 / $50.00`.                                                                                                                       |
| Team/enterprise shape differs                               | Usage card   | Missing `individualUsage.plan`                            | Render whatever rows parse. If none, show `{ message: "Cursor usage format not recognized (team plan?)." }` (see codeburn #1546).                                  |

## Performance UX

- **Login polling:** the client polls local status every 1.5 s (the existing
  constant). The server polls Cursor every 1-2 s and backs off on 429. Cap at
  about 5 min, the existing `MAX_ATTEMPTS=200` × 1.5 s, unless Cursor documents
  a different lifetime (open question).
- **Instant feedback:** disable the tab button and show a spinner inside it
  until the authorize call returns (usually under 300 ms). Don't flash the
  "waiting" state before the URL exists.
- **Usage fetch:** Provider Limits auto-refreshes every 60 s
  (`REFRESH_INTERVAL_MS`) and caches in localStorage (`QUOTA_CACHE_KEY`), so
  cached rows render immediately. Add a ~60 s server-side cache in the Cursor
  usage handler, honouring `force` like `claude.js`, so that many open
  dashboards don't hammer cursor.com. Don't cache soft-failure `{ message }`
  payloads (same rule as claude.js line ~42).
- **Loading skeleton:** the per-card spinner already exists. No change needed.

## Competitive Analysis

| Product                              | Login UX                                                                                                                                                                                  | Quota UX                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **cursor-agent CLI**                 | `agent login` opens the browser. `NO_OPEN_BROWSER=1` prints the URL for remote/headless use. `agent status` / `agent logout` handle the rest. Same loginDeepControl + auth/poll PKCE.     | None in the CLI.                                                                                                                                                            |
| **GitHub CLI**                       | Device flow: prints a one-time code, "press Enter to open browser", `--clipboard` copies the code, `--web` skips prompts, env-token for headless.                                         | n/a                                                                                                                                                                         |
| **t3code** (PR #12948)               | Settings → Providers → Cursor: **Sign in**, then **Switch account** / **Sign out**. Links open on the _client_, so remote hosts work. Cancelled or expired flows can't save late results. | Usage-limits UI still a feature request (#5539), framed as multiple buckets with reset times.                                                                               |
| **OpenChamber / opencode-cursor**    | "Set up" → open link → approve in browser. No API key. Models load automatically after sign-in. PKCE tokens auto-refresh.                                                                 | n/a                                                                                                                                                                         |
| **OmniRoute** (9router fork lineage) | Providers → Cursor OAuth login in the dashboard.                                                                                                                                          | Provider quota dashboard with normalized cards, like our Provider Limits.                                                                                                   |
| **OpenUsage / ClaudeBar / codeburn** | Read IDE-local credentials.                                                                                                                                                               | Show Total, Auto and API % separately (ClaudeBar #303: API can be 97% while Total is 50%), USD for spend, warning at ≥80% and "limited" at ≥100%, bonus tracked separately. |

Takeaways: link-on-client plus server-side polling is the standard for
remote-friendly Cursor login. Offer an explicit cancel. Show all three percentage
windows, not just Total. Show dollars as dollars.

## Recommendations

### Must

1. Put the **browser-login tab** in `src/shared/components/CursorAuthModal.js`
   as the default. Reuse OAuthModal's URL block, spinner, success and error
   panels, and `useCopyToClipboard`. Make "Import from Cursor IDE" the second
   tab and run auto-detect only when that tab is opened.
2. Keep the verifier and tokens **server-side**. The client only sees
   `{ loginUrl, state, expiresAt }` and polls a `poll-status?state=` endpoint
   (same contract as the codex/xai/proxy flows in OAuthModal). Closing the modal
   cancels the flow, and late results are discarded.
3. Clear terminal states: success, expired (Try Again issues a new link),
   upstream error with a trimmed message, and Cancel.
4. **Usage handler** (`open-sse/services/usage/cursor.js`, registered in
   `USAGE_HANDLERS`, plus `features.usage: true` in
   `open-sse/providers/registry/cursor.js`):
   - Return `{ plan, quotas: { Total, "Auto + Composer", API, On-demand? } }`,
     each row with `resetAt = billingCycleEnd` and `remainingPercentage`
     clamped to 0-100.
   - Soft-fail to `{ message }` and never throw.
   - Auth messages include "expired"/"re-authorize" and reconnect guidance.
5. Add a `cursor` case in `ProviderLimits/utils.js` `parseQuotaData` that
   forwards `remainingPercentage`, `detail` and `unlimited` and keeps row order.
   Do **not** forward absolute `remaining`.
6. Omit the On-demand row when it's disabled. Clamp percentages above 100 and
   label them as bonus without using `message`.

### Should

1. Add an optional `detail` override in `QuotaTable.js` for `$` and `% used ·
bonus` text (additive and backwards-compatible).
2. Render the plan **Badge** in the `ProviderLimits/index.js` card header, with
   `planVariants` moved to `utils.js` and shared with `ProviderLimitCard.js`.
3. Show a "Didn't finish?" hint after ~60 s of pending, and a countdown to
   `expiresAt`.
4. Dedupe by account on login (update rather than duplicate) and say so in the
   success copy.
5. Add a server-side 60 s cache for Cursor usage, honouring `?force=1`.

### Nice to have

1. Add a **Reconnect** button on expired Cursor connections (provider page and
   usage card) that opens the modal on the browser tab for that connection.
2. Show a QR code of the login URL for phone sign-in when 9router is headless.
   No QR dependency exists in `package.json`, so this needs a dependency
   justification. Defer.
3. Add a tooltip on the Auto + Composer and API rows explaining what each bucket
   covers (Cursor's own models vs third-party API models).
4. Add a small "billing cycle X% elapsed" hint beside Total so users can tell
   whether they're on pace (OpenUsage does this).

## Open Questions

1. How long does a `loginDeepControl` uuid/challenge stay valid? This sets the
   timeout and countdown. Default to 5 min until measured.
2. Which usage source does the backend use? `cursor.com/api/usage-summary` needs
   the `WorkosCursorSessionToken` cookie (`userId::accessToken`), not Bearer.
   Confirm it works with PKCE-issued tokens and with imported IDE tokens.
3. Are on-demand `used`/`limit` always in cents? Is the plan `limit` in cents or
   requests for older request-based plans? This decides whether Total can show
   `$` detail or only a percentage.
4. Where should the plan name come from: `membershipType` from usage-summary
   (pro/ultra/…) or a separate stripe/profile call? Map it to title case for the
   Badge ("Ultra").
5. Do PKCE tokens include a refresh token that `CursorExecutor.refreshCredentials`
   can use? It currently returns `null`. If not, the "session expired →
   reconnect" path is the main recovery and the Reconnect button moves up to
   Should.
6. Should the Import tab stay visible in Docker, where auto-import can never
   work, or collapse to manual paste only? Recommendation: keep it and skip
   auto-detect until the tab is selected.
7. Team/enterprise accounts: show pooled `teamUsage.onDemand` as a separate row,
   or leave it out of scope for YAN-385?

## Sources

- Codebase (master @ 27a7d59a): `src/shared/components/CursorAuthModal.js`,
  `OAuthModal.js`, `ProxyOAuthPanel.js`, `KiroAuthModal.js`,
  `KiroOAuthWrapper.js`;
  `src/app/(dashboard)/dashboard/providers/[id]/page.js` (lines ~2056-2090);
  `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/{index.js,QuotaTable.js,utils.js,ProviderLimitCard.js,QuotaProgressBar.js}`;
  `src/app/api/usage/[connectionId]/route.js`;
  `open-sse/services/usage/{grok-cli.js,zed.js,claude.js}`;
  `open-sse/executors/cursor.js`; `open-sse/providers/registry/cursor.js`.
- Cursor CLI authentication docs: <https://cursor.com/docs/cli/reference/authentication>
- Cursor PKCE flow (loginDeepControl + auth/poll): <https://github.com/CoreUnit-NET/cursed-gateway>,
  <https://github.com/wrfly/AgentLodge/pull/65>, <https://github.com/webplode/pi-cursor>
- Unofficial usage-summary docs: <https://gist.github.com/dmwyatt/1e9359b1862e7cbfe1e754fe4c8db764>
- ClaudeBar Auto/API split: <https://github.com/tddworks/ClaudeBar/issues/303>
- codeburn enterprise shape: <https://github.com/getagentseal/codeburn/issues/1546>
- OpenUsage Cursor provider: <https://openusage.sh/docs/providers/cursor/>
- t3code Cursor browser login: <https://github.com/pingdotgg/t3code/pull/12948>;
  limits UI request <https://github.com/pingdotgg/t3code/issues/5539>
- OpenChamber integrations: <https://docs.openchamber.dev/integrations/>
- GitHub CLI `gh auth login`: <https://cli.github.com/manual/gh_auth_login>
- OmniRoute usage/quotas: <https://deepwiki.com/diegosouzapw/OmniRoute/6.4-provider-usage-and-quotas>
