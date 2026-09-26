import { describe, expect, it } from "vitest";
import {
  appendConsoleLines,
  autoScrollReducer,
  countConsoleLevels,
  filterConsoleLines,
  initialAutoScrollState,
  initialConsoleBufferState,
  parseConsoleLine,
  pauseBufferReducer,
} from "../../src/shared/utils/consoleLog.js";

const LINES = [
  { time: "14:07:10", level: "INFO", message: "POST /v1/chat/completions model=coder" },
  { time: "14:07:19", level: "WARN", message: "gc/gemini 429 rate_limited cooling down" },
  { time: "14:07:31", level: "ERROR", message: "kimi: token refresh failed 401" },
  { time: "14:07:41", level: "DEBUG", message: "caveman(full): output 1204 → 431 tokens" },
  { time: "14:08:20", level: "INFO", message: "← 200 cc/claude-sonnet in=9810 out=1022" },
];

describe("parseConsoleLine", () => {
  it("parses timestamp, level and message", () => {
    expect(parseConsoleLine("[14:07:19] [WARN] cooling down")).toEqual({
      time: "14:07:19",
      level: "WARN",
      message: "cooling down",
    });
  });

  it("maps request-logger emoji to levels", () => {
    expect(parseConsoleLine("[14:07:19] ⚠️ [gc] 429 cooling down")).toMatchObject({
      time: "14:07:19",
      level: "WARN",
    });
    expect(parseConsoleLine("[14:07:31] ❌ [kimi] refresh failed")).toMatchObject({
      level: "ERROR",
    });
    expect(parseConsoleLine("[14:07:41] 🔍 [rtk] compressed")).toMatchObject({ level: "DEBUG" });
    expect(parseConsoleLine("[14:07:10] ℹ️ [api] POST /v1/chat")).toMatchObject({ level: "INFO" });
  });

  it("falls back to LOG for unknown levels and plain lines", () => {
    expect(parseConsoleLine("Server listening on :20128")).toEqual({
      time: "",
      level: "LOG",
      message: "Server listening on :20128",
    });
    expect(parseConsoleLine("[oops] something odd")).toEqual({
      time: "",
      level: "LOG",
      message: "[oops] something odd",
    });
    expect(parseConsoleLine("[DB] Driver: node:sqlite")).toMatchObject({
      level: "LOG",
      message: "[DB] Driver: node:sqlite",
    });
  });

  it("throws on non-string input", () => {
    expect(() => parseConsoleLine(null)).toThrow();
  });
});

describe("filterConsoleLines", () => {
  it("matches message text case-insensitively", () => {
    expect(filterConsoleLines(LINES, { query: "GEMINI", level: "ALL" })).toHaveLength(1);
    expect(filterConsoleLines(LINES, { query: "200", level: "ALL" })).toHaveLength(1);
  });

  it("filters by level", () => {
    expect(filterConsoleLines(LINES, { query: "", level: "INFO" })).toHaveLength(2);
    expect(filterConsoleLines(LINES, { query: "", level: "ERROR" })).toHaveLength(1);
  });

  it("combines text and level filters", () => {
    expect(filterConsoleLines(LINES, { query: "post", level: "INFO" })).toHaveLength(1);
    expect(filterConsoleLines(LINES, { query: "post", level: "WARN" })).toHaveLength(0);
  });

  it("returns everything for empty query and ALL", () => {
    expect(filterConsoleLines(LINES, { query: "  ", level: "ALL" })).toHaveLength(5);
  });
});

describe("countConsoleLevels", () => {
  it("counts per level", () => {
    expect(countConsoleLevels(LINES)).toEqual({ LOG: 0, INFO: 2, WARN: 1, ERROR: 1, DEBUG: 1 });
  });

  it("counts empty input as zeros", () => {
    expect(countConsoleLevels([])).toEqual({ LOG: 0, INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 });
  });
});

describe("pauseBufferReducer", () => {
  it("appends while live", () => {
    const state = pauseBufferReducer(initialConsoleBufferState, {
      type: "append",
      lines: [LINES[0]],
      maxLines: 200,
    });
    expect(state.visible).toHaveLength(1);
    expect(state.pending).toHaveLength(0);
    expect(state.newCount).toBe(0);
  });

  it("buffers while paused and shows new count", () => {
    let state = pauseBufferReducer(initialConsoleBufferState, { type: "pause" });
    state = pauseBufferReducer(state, {
      type: "append",
      lines: [LINES[0], LINES[1]],
      maxLines: 200,
    });
    expect(state.visible).toHaveLength(0);
    expect(state.pending).toHaveLength(2);
    expect(state.newCount).toBe(2);
    expect(state.paused).toBe(true);
  });

  it("flushes pending on resume with the 200-line cap", () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ ...LINES[0], message: `m${i}` }));
    let state = pauseBufferReducer(initialConsoleBufferState, { type: "pause" });
    state = pauseBufferReducer(state, { type: "append", lines: many, maxLines: 200 });
    state = pauseBufferReducer(state, { type: "resume", maxLines: 200 });
    expect(state.paused).toBe(false);
    expect(state.pending).toHaveLength(0);
    expect(state.newCount).toBe(0);
    expect(state.visible).toHaveLength(200);
    expect(state.visible[0].message).toBe("m50");
  });

  it("clears visible and pending", () => {
    let state = pauseBufferReducer(initialConsoleBufferState, { type: "pause" });
    state = pauseBufferReducer(state, {
      type: "append",
      lines: [LINES[0]],
      maxLines: 200,
    });
    state = pauseBufferReducer(state, { type: "clear" });
    expect(state.visible).toHaveLength(0);
    expect(state.pending).toHaveLength(0);
    expect(state.newCount).toBe(0);
  });

  it("throws on unknown actions", () => {
    expect(() => pauseBufferReducer(initialConsoleBufferState, { type: "nope" })).toThrow();
    expect(() =>
      pauseBufferReducer(initialConsoleBufferState, { type: "append", lines: [] }),
    ).toThrow();
  });
});

describe("appendConsoleLines", () => {
  it("caps at 200 lines keeping the newest", () => {
    const visible = Array.from({ length: 199 }, (_, i) => ({ ...LINES[0], message: `v${i}` }));
    const next = appendConsoleLines(visible, [{ ...LINES[0], message: "new" }], 200);
    expect(next).toHaveLength(200);
    expect(next[199].message).toBe("new");
  });
});

describe("autoScrollReducer", () => {
  it("starts enabled", () => {
    expect(initialAutoScrollState).toEqual({ enabled: true });
  });

  it("disables on user scroll-up, enables near bottom or toggle", () => {
    let state = autoScrollReducer(initialAutoScrollState, { type: "scroll", atBottom: false });
    expect(state.enabled).toBe(false);
    state = autoScrollReducer(state, { type: "scroll", atBottom: true });
    expect(state.enabled).toBe(true);
    state = autoScrollReducer(state, { type: "toggle" });
    expect(state.enabled).toBe(false);
    state = autoScrollReducer(state, { type: "toggle" });
    expect(state.enabled).toBe(true);
  });

  it("throws on unknown actions", () => {
    expect(() => autoScrollReducer(initialAutoScrollState, { type: "nope" })).toThrow();
  });
});
