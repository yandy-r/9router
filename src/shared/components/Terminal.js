"use client";

import PropTypes from "prop-types";
import { terminalLevelClass } from "./displayPrimitives";

/**
 * Terminal/console surface (dark in both themes) with level-colored lines.
 * Text colors are fixed-light (`.signal-terminal*` classes in globals.css) and
 * the log is always LTR, including in RTL locales.
 * @param {{ lines: {time?: string, level: "LOG"|"INFO"|"WARN"|"ERROR"|"DEBUG", message: string}[] }} props
 */
export default function Terminal({ lines, label = "Console output", className }) {
  return (
    <ol
      role="log"
      aria-label={label}
      dir="ltr"
      className={`signal-terminal m-0 list-none overflow-x-auto rounded-xl p-4 text-start font-mono text-xs leading-relaxed${className ? ` ${className}` : ""}`}
    >
      {lines.map((line, index) => (
        // Timestamps make each row unique; index only disambiguates duplicates.
        // biome-ignore lint/suspicious/noArrayIndexKey: no stable row id exists.
        <li key={`${line.time ?? ""}-${line.level}-${index}`} className="flex gap-3 whitespace-pre">
          {line.time && <span className="signal-terminal-time shrink-0">{line.time}</span>}
          <span className={`w-12 shrink-0 font-semibold ${terminalLevelClass(line.level)}`}>
            {line.level}
          </span>
          <span>{line.message}</span>
        </li>
      ))}
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
};
