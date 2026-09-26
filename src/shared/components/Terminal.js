"use client";

import PropTypes from "prop-types";
import { memo } from "react";
import { terminalLevelClass } from "./displayPrimitives";

/** Memoized terminal row with timestamp, level tag and keyboard-readable full text. */
const TerminalRow = memo(function TerminalRow({ line, onOpen }) {
  return (
    <li className="flex gap-4 whitespace-nowrap">
      <span className="signal-terminal-time shrink-0">{line.time || "--:--:--"}</span>
      <span className={`w-[52px] shrink-0 font-semibold ${terminalLevelClass(line.level)}`}>
        {line.level}
      </span>
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(line)}
          title={line.message}
          aria-label={`Show full line: ${line.message}`}
          className="min-w-0 flex-1 cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap rounded-sm bg-transparent p-0 text-start text-inherit hover:underline focus-visible:shadow-focus"
        >
          {line.message}
        </button>
      ) : (
        <span className="min-w-0 flex-1 whitespace-pre">{line.message}</span>
      )}
    </li>
  );
});

TerminalRow.propTypes = {
  line: PropTypes.shape({
    time: PropTypes.string,
    level: PropTypes.oneOf(["LOG", "INFO", "WARN", "ERROR", "DEBUG"]).isRequired,
    message: PropTypes.string.isRequired,
  }).isRequired,
  onOpen: PropTypes.func,
};

/**
 * Terminal/console surface (dark in both themes) with level-colored lines.
 * Text colors are fixed-light (`.signal-terminal*` classes in globals.css) and
 * the log is always LTR, including in RTL locales. The list region is
 * keyboard-focusable; each truncated row is a button that opens the full
 * line in a dialog. `live` should be off for a fast stream, polite while
 * paused.
 * @param {{ lines: {time?: string, level: "LOG"|"INFO"|"WARN"|"ERROR"|"DEBUG", message: string}[], label?: string, className?: string, live?: "off"|"polite", onScroll?: (event: object) => void, scrollRef?: { current: object }, cursor?: boolean, onOpenLine?: (line: {time?: string, level: string, message: string}) => void }} props
 */
export default function Terminal({
  lines,
  label = "Console output",
  className,
  live = "off",
  onScroll,
  scrollRef,
  cursor = false,
  onOpenLine,
}) {
  return (
    <ol
      ref={scrollRef}
      role="log"
      aria-label={label}
      aria-live={live}
      dir="ltr"
      onScroll={onScroll}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable log region must be keyboard-focusable (WCAG 2.1.1).
      tabIndex={0}
      className={`signal-terminal custom-scrollbar m-0 list-none overflow-auto rounded-2xl p-[18px_22px] text-start font-mono text-[13px] leading-[1.75] focus-visible:shadow-focus${className ? ` ${className}` : ""}`}
    >
      {lines.map((line, index) => (
        <TerminalRow
          // Timestamps repeat; index only disambiguates duplicates.
          // biome-ignore lint/suspicious/noArrayIndexKey: no stable row id exists.
          key={`${line.time ?? ""}-${line.level}-${index}`}
          line={line}
          onOpen={onOpenLine}
        />
      ))}
      {cursor && (
        <li className="mt-0.5 flex gap-4 whitespace-nowrap" aria-hidden="true">
          <span className="signal-terminal-time shrink-0">--:--:--</span>
          <span className="signal-terminal-cursor w-[52px] shrink-0 animate-pulse font-semibold">
            ▍
          </span>
        </li>
      )}
    </ol>
  );
}

Terminal.propTypes = {
  lines: PropTypes.arrayOf(
    PropTypes.shape({
      time: PropTypes.string,
      level: PropTypes.oneOf(["LOG", "INFO", "WARN", "ERROR", "DEBUG"]).isRequired,
      message: PropTypes.string.isRequired,
    }),
  ).isRequired,
  label: PropTypes.string,
  className: PropTypes.string,
  live: PropTypes.oneOf(["off", "polite"]),
  onScroll: PropTypes.func,
  scrollRef: PropTypes.shape({ current: PropTypes.object }),
  cursor: PropTypes.bool,
  onOpenLine: PropTypes.func,
};
