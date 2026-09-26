/**
 * Pure logic for the Console log page (YAN-302): line parsing, filtering,
 * level counts, the pause-buffer reducer and the auto-scroll state machine.
 * No React/DOM. Fail fast on unsupported input.
 */

/** Levels shown by the level SegmentedControl, in display order. */
export const CONSOLE_LEVELS = ["LOG", "INFO", "WARN", "ERROR", "DEBUG"];

const KNOWN_LEVELS = new Set(CONSOLE_LEVELS);

const LINE_RE = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*)?(?:\[([A-Za-z]+)\]\s*)?(.*)$/s;

/** Map request-logger emojis to console levels. */
const EMOJI_LEVELS = {
  "⚠️": "WARN",
  "❌": "ERROR",
  "🔍": "DEBUG",
  ℹ️: "INFO",
  ℹ: "INFO",
};

/**
 * Parse a raw server log line into a structured row. Server lines look like
 * `[14:07:19] ⚠️ [tag] message`, `[14:07:19] ℹ️ [tag] message` or plain text.
 * @param {string} rawLine
 * @returns {{ time: string, level: string, message: string }}
 */
export function parseConsoleLine(rawLine) {
  if (typeof rawLine !== "string") {
    throw new Error(`parseConsoleLine: expected a string, got ${typeof rawLine}`);
  }
  const match = rawLine.match(LINE_RE);
  const bracketLevel = (match[2] || "").toUpperCase();
  const emoji = Object.keys(EMOJI_LEVELS).find((mark) => match[3].startsWith(mark));
  const level = KNOWN_LEVELS.has(bracketLevel) ? bracketLevel : emoji ? EMOJI_LEVELS[emoji] : "LOG";
  const message = KNOWN_LEVELS.has(bracketLevel)
    ? match[3]
    : `${match[2] ? `[${match[2]}] ` : ""}${match[3]}`;
  return {
    time: match[1] || "",
    level,
    message: message || "",
  };
}

/**
 * Filter parsed lines by level and case-insensitive text query.
 * @param {{ level: string, message: string }[]} lines
 * @param {{ query?: string, level?: string }} [filters]
 * @returns {{ level: string, message: string }[]}
 */
export function filterConsoleLines(lines, filters = {}) {
  if (!Array.isArray(lines)) throw new Error("filterConsoleLines: expected an array of lines");
  const { query = "", level = "ALL" } = filters;
  if (level !== "ALL" && !KNOWN_LEVELS.has(level)) {
    throw new Error(`filterConsoleLines: unknown level "${level}"`);
  }
  const needle = query.trim().toLowerCase();
  return lines.filter(
    (line) =>
      (level === "ALL" || line.level === level) &&
      (needle === "" || line.message.toLowerCase().includes(needle)),
  );
}

/**
 * Count parsed lines per level.
 * @param {{ level: string }[]} lines
 * @returns {Record<string, number>}
 */
export function countConsoleLevels(lines) {
  if (!Array.isArray(lines)) throw new Error("countConsoleLevels: expected an array of lines");
  const counts = { LOG: 0, INFO: 0, WARN: 0, ERROR: 0, DEBUG: 0 };
  for (const line of lines) {
    if (counts[line.level] !== undefined) counts[line.level] += 1;
  }
  return counts;
}

/**
 * Assign stable, monotonically increasing ids to freshly ingested lines.
 * Ids identify exact rows (including duplicates) and never change after head
 * drops at the buffer cap.
 * @param {object[]} lines
 * @param {number} startId
 * @returns {{ lines: object[], nextId: number }}
 */
export function tagConsoleLines(lines, startId) {
  if (!Array.isArray(lines)) throw new Error("tagConsoleLines: expected an array of lines");
  if (!Number.isInteger(startId) || startId < 0) {
    throw new Error(`tagConsoleLines: expected a non-negative startId, got ${startId}`);
  }
  return {
    lines: lines.map((line, index) => ({ ...line, id: startId + index })),
    nextId: startId + lines.length,
  };
}

/**
 * Cap a visible-lines array at maxLines, keeping the newest.
 * Existing row objects are preserved by reference so memoized rows do not
 * re-render merely because the buffer head dropped.
 * @param {object[]} visible
 * @param {object[]} lines
 * @param {number} maxLines
 * @returns {object[]}
 */
export function appendConsoleLines(visible, lines, maxLines) {
  if (!Array.isArray(visible) || !Array.isArray(lines)) {
    throw new Error("appendConsoleLines: expected arrays");
  }
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new Error(`appendConsoleLines: expected a positive maxLines, got ${maxLines}`);
  }
  const next = [...visible, ...lines];
  return next.length > maxLines ? next.slice(-maxLines) : next;
}

export const initialConsoleBufferState = {
  paused: false,
  visible: [],
  pending: [],
  newCount: 0,
  /** Next stable row id for ingested lines. Monotonic per page lifetime. */
  nextId: 0,
};

/**
 * Pause-buffer reducer: appends while live; buffers while paused; resume
 * flushes (capped); clear empties both lists.
 * @param {{ paused: boolean, visible: object[], pending: object[], newCount: number, nextId: number }} state
 * @param {{ type: string, lines?: object[], maxLines?: number }} action
 */
function reducerMaxLines(action) {
  if (!Number.isInteger(action.maxLines) || action.maxLines <= 0) {
    throw new Error("pauseBufferReducer: resume/append needs a positive maxLines");
  }
  return action.maxLines;
}

export function pauseBufferReducer(state, action) {
  switch (action.type) {
    case "pause":
      return { ...state, paused: true };
    case "resume": {
      const maxLines = reducerMaxLines(action);
      const tagged = tagConsoleLines(state.pending, state.nextId);
      return {
        ...state,
        paused: false,
        visible: appendConsoleLines(state.visible, tagged.lines, maxLines),
        pending: [],
        newCount: 0,
        nextId: tagged.nextId,
      };
    }
    case "append": {
      if (!Array.isArray(action.lines)) throw new Error("pauseBufferReducer: append needs lines");
      const maxLines = reducerMaxLines(action);
      const tagged = tagConsoleLines(action.lines, state.nextId);
      if (state.paused) {
        // Pending only needs the newest maxLines; the flush caps visible too.
        const pending = [...state.pending, ...tagged.lines].slice(-maxLines);
        return { ...state, pending, newCount: pending.length, nextId: tagged.nextId };
      }
      return {
        ...state,
        visible: appendConsoleLines(state.visible, tagged.lines, maxLines),
        nextId: tagged.nextId,
      };
    }
    case "clear":
      return { ...state, visible: [], pending: [], newCount: 0 };
    default:
      throw new Error(`pauseBufferReducer: unknown action "${action?.type}"`);
  }
}

export const initialAutoScrollState = { enabled: true };

/**
 * Auto-scroll state machine: user scroll-up disables, near-bottom scroll
 * re-enables, toggle flips.
 * @param {{ enabled: boolean }} state
 * @param {{ type: string, atBottom?: boolean }} action
 */
export function autoScrollReducer(state, action) {
  switch (action.type) {
    case "scroll":
      return { enabled: action.atBottom !== false };
    case "toggle":
      return { enabled: !state.enabled };
    default:
      throw new Error(`autoScrollReducer: unknown action "${action?.type}"`);
  }
}
