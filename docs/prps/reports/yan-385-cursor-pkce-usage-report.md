# Implementation Report: Cursor browser login, token refresh, and plan usage (YAN-385)

## Summary

This change adds five things for Cursor:

- **Browser login**: a PKCE deep-control flow through the generic `device_code` route and modal.
- **Real session refresh**: via `POST api2.cursor.sh/oauth/token`, including for legacy imported rows that have no refresh token.
- **JWT-based expiry**: import no longer hard-codes 24h.
- **Plan usage**: shown in Provider Limits and fed to the quota snapshot (`month` window + `planTier`).
- **Connect-error classification**: `unauthenticated` maps to 401 and `permission_denied` to 403, so refresh and fallback now trigger.

## Assessment vs Reality

| Metric        | Predicted (Plan)    | Actual                         |
| ------------- | ------------------- | ------------------------------ |
| Complexity    | Large               | Large                          |
| Confidence    | 8/10                | 9/10 (live-verified)           |
| Files Changed | 20 (4 new + 16 upd) | 22 (5 new + 17 upd, +901/−141) |

## Tasks Completed

| #   | Task                                         | Status          | Notes                                                            |
| --- | -------------------------------------------- | --------------- | ---------------------------------------------------------------- |
| 1.1 | Registry constants                           | [done] Complete |                                                                  |
| 1.2 | `open-sse/shared/cursorAuth.js`              | [done] Complete | Also exports fallback URL constants                              |
| 2.1 | Track A: device-code provider + import fixes | [done] Complete | Removed dead checksum/header methods from `CursorService`        |
| 2.2 | Track B: refresher + executor                | [done] Complete |                                                                  |
| 2.3 | Track C: usage handler, snapshot, capacity   | [done] Complete |                                                                  |
| 2.4 | Track D: connect UI                          | [done] Complete | Editing the access token by hand clears a detected refresh token |
| 3.1 | `cursor-auth.test.js`                        | [done] Complete | 11 tests                                                         |
| 3.2 | `cursor-usage.test.js`                       | [done] Complete | 11 tests                                                         |
| 4.1 | Integration validation                       | [done] Complete |                                                                  |

## Validation Results

| Level           | Status      | Notes                                                                                  |
| --------------- | ----------- | -------------------------------------------------------------------------------------- |
| Static Analysis | [done] Pass | `npm run lint` exit 0 (existing warnings only)                                         |
| Unit Tests      | [done] Pass | `npm test`: no regression (86 fails, all in known-fails, baseline 89); 22 new tests    |
| Baselines       | [done] Pass | verify-providers / alias / oauth-urls byte-for-byte equal                              |
| Build           | [done] Pass | `next build` compiled successfully                                                     |
| Integration     | [done] Pass | Live run in the 9router-dev container (see below)                                      |
| Edge Cases      | [done] Pass | Dead session (HTTP 200 `shouldLogout`), policy 403, omitted proto3 fields, team pooled |

Live checks, run in the 9router-dev container against real Cursor with the worktree code:

- **Usage**: `getCursorUsage` returned plan "Ultra" and the rows Total 86.2%, Auto + Composer 97.5%, API 18.6% and On-demand $94.69 / $100, with the reset at 2026-10-03.
- **Refresh**: `CursorExecutor.refreshCredentials` on a legacy imported row (no refresh token) returned a new 60-day JWT with the same `sub`. A garbage token returned `invalid_grant`.
- **Login start**: `requestDeviceCode` produced a cursor.com login URL that returns 200, and `pollToken` reported `authorization_pending`.
- **Not run**: the interactive browser sign-in itself, which needs a human.

## Deviations from Plan

- Task 1.2 exports the fallback endpoint constants.
- Task 2.3 returns "unavailable (invalid response)" for non-JSON usage bodies.
- Task 2.4 puts the helper text under the buttons, and editing the access token clears the detected refresh token.

## Issues Encountered

- `npm run lint` initially failed on the untracked `.prp-research` scratch notes. They were removed; they were never meant to be committed.
- ShellCheck is not installed locally, which is an environment gap. CI runs it.

## Tests Written

| Test File                         | Tests | Coverage                                                                  |
| --------------------------------- | ----- | ------------------------------------------------------------------------- |
| `tests/unit/cursor-auth.test.js`  | 11    | Login URL, poll mapping, mapTokens, refresh semantics, dispatch, executor |
| `tests/unit/cursor-usage.test.js` | 11    | Parser (bonus %, omitted, team), tier, 401 message, request shape, kind   |

## Next Steps

- [ ] Code review
- [ ] PR (`Closes #253`, YAN-385)
- [ ] Manual: an interactive browser login in the dashboard
