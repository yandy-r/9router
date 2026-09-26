"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import {
  Button,
  Callout,
  EmptyState,
  Input,
  Modal,
  SegmentedControl,
  StatusPill,
  Terminal,
  Toggle,
} from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { CONSOLE_LOG_CONFIG } from "@/shared/constants/config";
import {
  autoScrollReducer,
  countConsoleLevels,
  filterConsoleLines,
  initialAutoScrollState,
  initialConsoleBufferState,
  parseConsoleLine,
  pauseBufferReducer,
} from "@/shared/utils/consoleLog";

const MAX_LINES = CONSOLE_LOG_CONFIG.maxLines;
const LEVEL_OPTIONS = ["ALL", "INFO", "WARN", "ERROR", "DEBUG"];
const SCROLL_THRESHOLD_PX = 48;

/**
 * Signal Console log page: live SSE stream with pause/resume buffering,
 * text + level filters with counts, auto-scroll toggle and a terminal
 * surface with level-colored rows.
 */
export default function ConsoleLogClient() {
  const notify = useNotificationStore((state) => state.error);
  const [buffer, dispatchBuffer] = useReducer(pauseBufferReducer, initialConsoleBufferState);
  const [autoScroll, dispatchAutoScroll] = useReducer(autoScrollReducer, initialAutoScrollState);
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState("ALL");
  const [selectedLine, setSelectedLine] = useState(null);
  const [connected, setConnected] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const scrollRef = useRef(null);

  const paused = buffer.paused;
  const visible = buffer.visible;

  useEffect(() => {
    const es = new EventSource("/api/translator/console-logs/stream");

    es.onopen = () => {
      setConnected(true);
      setStreamError(false);
    };

    es.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "init" && Array.isArray(msg.logs)) {
        dispatchBuffer({ type: "clear" });
        dispatchBuffer({
          type: "append",
          lines: msg.logs.map(parseConsoleLine),
          maxLines: MAX_LINES,
        });
      } else if (msg.type === "line" && typeof msg.line === "string") {
        dispatchBuffer({
          type: "append",
          lines: [parseConsoleLine(msg.line)],
          maxLines: MAX_LINES,
        });
      } else if (msg.type === "lines" && Array.isArray(msg.lines)) {
        dispatchBuffer({
          type: "append",
          lines: msg.lines.map(parseConsoleLine),
          maxLines: MAX_LINES,
        });
      } else if (msg.type === "clear") {
        dispatchBuffer({ type: "clear" });
      }
    };

    es.onerror = () => {
      setConnected(false);
      setStreamError(true);
    };

    return () => es.close();
  }, []);

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= SCROLL_THRESHOLD_PX;
    dispatchAutoScroll({ type: "scroll", atBottom });
  }, []);

  // Stick to the bottom on new visible lines when auto-scroll is on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `visible` is the trigger; its length stalls at the 200-line cap.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !autoScroll.enabled) return;
    node.scrollTop = node.scrollHeight;
  }, [visible, autoScroll.enabled]);

  const handleClear = useCallback(async () => {
    try {
      const res = await fetch("/api/translator/console-logs", { method: "DELETE" });
      if (!res.ok) {
        notify("Could not clear the console log. Try again.", "Clear failed");
        return;
      }
      // Clearing is optimistic: the SSE "clear" broadcast confirms it, and
      // this keeps the UI correct if the stream is momentarily down.
      dispatchBuffer({ type: "clear" });
    } catch {
      notify("Could not clear the console log. Try again.", "Clear failed");
    }
  }, [notify]);

  const counts = useMemo(() => countConsoleLevels(visible), [visible]);
  const filtered = useMemo(
    () => filterConsoleLines(visible, { query, level }),
    [visible, query, level],
  );
  const warnCount = counts.WARN;
  const errorCount = counts.ERROR;

  const options = useMemo(
    () =>
      LEVEL_OPTIONS.map((value) => ({
        value,
        label: value === "ALL" ? "All" : value.charAt(0) + value.slice(1).toLowerCase(),
        count: value === "ALL" ? visible.length : counts[value],
      })),
    [visible.length, counts],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Header row: subtitle is in the shell Header; actions live here */}
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill variant={paused ? "warn" : "live"} dot>
          {paused ? `Paused · ${buffer.newCount} new` : "Live"}
        </StatusPill>
        <span className="sr-only" role="status">
          {paused ? `Stream paused, ${buffer.newCount} new lines buffered` : "Streaming live"}
        </span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={paused ? "play_arrow" : "pause"}
            onClick={() =>
              dispatchBuffer(paused ? { type: "resume", maxLines: MAX_LINES } : { type: "pause" })
            }
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" variant="ghost" icon="delete" onClick={handleClear}>
            Clear
          </Button>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-[200px] flex-1 sm:max-w-[440px]">
          <Input
            icon="search"
            aria-label="Filter lines"
            placeholder="Filter by model, provider or status"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <SegmentedControl
          aria-label="Log level"
          options={options}
          value={level}
          onChange={setLevel}
        />
        <div className="ms-auto">
          <Toggle
            label="Auto-scroll"
            checked={autoScroll.enabled}
            onChange={() => dispatchAutoScroll({ type: "toggle" })}
          />
        </div>
      </div>

      {/* Terminal surface */}
      {streamError && visible.length === 0 ? (
        <Callout variant="err" title="Log stream unreachable">
          Could not connect to the log stream. Check that the gateway is running, then reload the
          page.
        </Callout>
      ) : null}
      {filtered.length === 0 ? (
        <div className="signal-terminal flex min-h-[320px] items-center justify-center rounded-2xl">
          <EmptyState
            icon="terminal"
            title={visible.length === 0 ? "No console logs yet" : "No lines match the filters"}
            body={
              visible.length === 0
                ? "Server output will appear here once the gateway starts logging."
                : "Try a different search term or log level."
            }
            className="[&_h3]:text-[var(--signal-terminal-text)] [&_p]:text-[var(--signal-terminal-time)]"
          />
        </div>
      ) : (
        <Terminal
          lines={filtered}
          scrollRef={scrollRef}
          onScroll={handleScroll}
          live={paused ? "polite" : "off"}
          label="Console output"
          cursor={!paused}
          onOpenLine={setSelectedLine}
          className="h-[min(60vh,720px)] min-h-[320px]"
        />
      )}
      <Modal
        isOpen={selectedLine !== null}
        onClose={() => setSelectedLine(null)}
        title={selectedLine ? `${selectedLine.time || "--:--:--"} · ${selectedLine.level}` : ""}
        size="lg"
      >
        <p className="font-mono text-sm break-words whitespace-pre-wrap">{selectedLine?.message}</p>
      </Modal>

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-muted">
        <span>
          {visible.length} of {MAX_LINES} lines
        </span>
        <span className="text-warn">{warnCount} warnings</span>
        <span className="text-err">
          {errorCount} {errorCount === 1 ? "error" : "errors"}
        </span>
        {!connected && visible.length > 0 ? <span>Reconnecting…</span> : null}
        <span className="ms-auto">
          Tip: turn on request details in{" "}
          <Link href="/dashboard/profile" className="font-semibold text-coral-ink">
            Settings → Observability
          </Link>{" "}
          to see full payloads in Usage.
        </span>
      </div>
    </div>
  );
}
