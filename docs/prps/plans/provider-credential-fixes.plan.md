# Plan: Provider credential correctness (YAN-109, YAN-108, YAN-131, YAN-123)

## Summary

Fix four related provider credential bugs in one PR: authenticated OpenRouter probe, cookie credential edit, stale check result, and silent name-collision overwrite.

## User Story

As dashboard user, I need connection checks and credential edits to reflect actual current credentials, with no silent replacement of another connection.

## Problem → Solution

Public OpenRouter model listing accepts garbage keys; key edits reuse prior successful validation; cookie edits are discarded; a reused Add form name silently upserts prior API key. Probe authenticated endpoint; bind validation to current input and revalidate on save; persist cookie credentials; clear Add state on open and reject duplicate API-key names at API POST boundary.

## Metadata

- **Complexity**: Medium (6 app files, 2-3 focused test files)
- **Branch**: `fix/provider-credential-fixes`
- **Worktree**: `.config/opencode/worktrees/9router-provider-credential-fixes/`
- **Issues**: GitHub #125 / YAN-109, #127 / YAN-108, #124 / YAN-131, #126 / YAN-123
- **Area**: dashboard and provider connection API; no routing engine changes.

## UX Design

### Before

Valid badge persists after key changes; Add reopens with prior credentials; duplicate name overwrites existing key without warning.

### After

Changing key clears badge; reopening Add starts blank; duplicate name shows explicit error and keeps modal open.

### Interaction Changes

Check button validates typed key; Save always revalidates changed key (no stale cached result). Validation failure does not label connection active. If key changes during an in-flight check, stale result must not be displayed or reused.

## Mandatory Reading

- `CLAUDE.md` — architecture and commands.
- `src/app/api/providers/validate/route.js` — provider probe switch.
- `src/app/api/providers/[id]/test/testUtils.js` — existing OpenRouter authenticated probe.
- `src/app/api/providers/[id]/route.js` — credential updates and response redaction.
- `src/app/api/providers/route.js` — POST boundary and connection upsert.
- `src/lib/db/repos/connectionsRepo.js` — apikey name-based upsert.
- `src/shared/components/EditConnectionModal.js` — validation lifecycle.
- `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js` — Add form lifecycle.
- `tests/unit/weighted-account-overrides.test.js` — direct route handler mock pattern.

## External Documentation

- OpenRouter authentication: <https://openrouter.ai/docs/api/reference/authentication>. Live probe (2026-09-25): `GET /api/v1/models` with `Bearer garbage` returned 200; `GET /api/v1/auth/key` returned 401. No real key needed for tests.

## Patterns to Mirror

- `src/app/api/providers/[id]/test/testUtils.js:676-683`: authenticated GET `/api/v1/auth/key`, Bearer header, `res.ok`.
- `src/app/(dashboard)/dashboard/providers/[id]/AddCustomModelModal.js:24-31`: reset local form state when `isOpen` becomes true.
- `tests/unit/weighted-account-overrides.test.js:46-79`: `vi.mock("next/server")`, mock DB functions, dynamic route import, real Request with async params.
- `tests/unit/compatible-provider-connections.test.js:38-46`: POST route against isolated temp DB.
- `src/app/api/providers/[id]/route.js:249-254`: redact credentials in response.

## Files to Change

- `src/app/api/providers/validate/route.js`: authenticated OpenRouter probe.
- `src/app/api/providers/[id]/route.js`: accept cookie updates.
- `src/app/api/providers/route.js`: reject duplicate names before API-key create.
- `src/shared/components/EditConnectionModal.js`: clear stale validation; always validate changed key on save.
- `src/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal.js`: reset form, bulk state, validation on open; clear badge when key changes.
- `tests/unit/compatible-provider-connections.test.js`: duplicate POST regression.
- `tests/unit/provider-credential-validation.test.js` (new): focused mocked route tests for OpenRouter and cookie update.

## NOT Building

No new dependency, DB migration, registry refactor, provider support, or live credential test. Retain repository upsert contract for non-POST callers; reject duplicates at user-facing POST boundary. No broad UI test harness; verify UI state via review and build, server behavior via focused Vitest.

## Step-by-Step Tasks

### Task 1: Backend credential integrity

- **ACTION**: Change OpenRouter probe to authenticated `/auth/key`; persist cookie edits; guard POST name collisions.
- **IMPLEMENT**: Use existing provider-scoped connections lookup before API-key insert, return 409 with clear error; do not alter `createProviderConnection` upsert behavior. Preserve secret redaction and existing OAuth flows.
- **VALIDATE**: Mock OpenRouter 401 and 200 fetch; PUT cookie update; POST duplicate returns 409 without DB mutation.

### Task 2: Dashboard state lifecycle

- **ACTION**: Reset Add form on open; invalidate Edit check after key change and avoid stale async results.
- **IMPLEMENT**: Keep existing validation handling style; save revalidates submitted key regardless of prior check. Clear Add field and bulk state when opening, keep errors readable on duplicate-name 409.
- **VALIDATE**: Inspect modal transitions and network/save flow; run lint/build and focused tests.

### Task 3: Integration verification and PR

- **ACTION**: Run focused tests, full gated suite, lint, build; review PR, fix findings, monitor CI, squash merge, cleanup and close Linear issues.
- **VALIDATE**: CI green, merged PR contains Closes #125 #127 #124 #126; no local/remote feature branch or worktree left; four Linear issues Done.

## Testing Strategy

- Minimal direct route tests for auth probe bad/good responses and cookie update.
- Isolated DB test for duplicate POST preserving existing credential.
- UI interaction reasoning: fresh Add form, stale Check response, Save with changed key. Add automated component test only if existing renderer supports it; none currently exists.

## Validation Commands

- `cd tests && npx vitest run unit/provider-credential-validation.test.js unit/compatible-provider-connections.test.js`
- `npm run lint`
- `npm test` (app files changed; gated baseline)
- `npm run build`

## Acceptance Criteria

- Garbage OpenRouter key fails; real authenticated response succeeds.
- PUT cookie connection stores new credential; API response does not expose it.
- Stale valid check cannot mark changed key active; out-of-order checks cannot certify different input.
- Reopening Add clears previous key/name; duplicate POST name reports 409 and preserves existing row.
- PR merged with green CI, branches/worktree cleaned, Linear issues Done.

## Risks

- Name-based upsert may serve other integrations. Guard only POST, leave repo semantics unchanged.
- Async validation race may show wrong badge; tie displayed result to checked key or discard stale response.
- App test suite has known failures; use committed regression baseline, not raw all-green expectation.
