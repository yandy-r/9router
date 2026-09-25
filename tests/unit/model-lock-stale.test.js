// Regression (YAN-81 / YAN-132): an expired per-model lock must not hide an
// active account-wide lock, in the router or in the dashboard's cooldown timer.
import { describe, expect, it } from "vitest";
import {
  getEarliestModelLockUntil,
  isModelLockActive,
  MODEL_LOCK_ALL,
} from "../../open-sse/services/accountFallback.js";

const past = new Date(Date.now() - 60_000).toISOString();
const future = new Date(Date.now() + 30 * 86_400_000).toISOString();

describe("stale per-model lock vs active account-wide lock", () => {
  const connection = { "modelLock_gpt-4o": past, [MODEL_LOCK_ALL]: future };

  it("isModelLockActive honours the account-wide lock", () => {
    expect(isModelLockActive(connection, "gpt-4o")).toBe(true);
  });

  it("getEarliestModelLockUntil skips the expired lock", () => {
    expect(getEarliestModelLockUntil(connection)).toBe(future);
  });

  it("is unlocked when every lock has expired", () => {
    expect(isModelLockActive({ "modelLock_gpt-4o": past, [MODEL_LOCK_ALL]: past }, "gpt-4o")).toBe(
      false,
    );
  });
});
