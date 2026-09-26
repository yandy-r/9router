"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import SegmentedControl from "@/shared/components/SegmentedControl";
import { deriveCommandCenterStatus } from "@/shared/utils/commandCenter";
import { connectionHealth } from "./ProviderHealth";

/** Home periods: the segmented control drives every stat. */
export const HOME_PERIODS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

/**
 * Home page header: derived status line, H1 "Command center" and the
 * Today/7d/30d control. The status text is plain English translated at render.
 *
 * @param {object} props
 * @param {Array<object>} props.connections provider connections for the status line
 * @param {boolean} props.providersLoading true while connections load ("…" line)
 * @param {"today"|"7d"|"30d"} props.period
 * @param {(period: string) => void} props.onPeriodChange
 */
export default function HomeHeader({ connections, providersLoading, period, onPeriodChange }) {
  const [labels, setLabels] = useState(null);

  useEffect(() => {
    setLabels(
      document.documentElement.lang.startsWith("zh")
        ? { today: "今天", "7d": "7天", "30d": "30天" }
        : null,
    );
  }, []);

  const options = labels
    ? HOME_PERIODS.map((item) => ({ ...item, label: labels[item.value] }))
    : HOME_PERIODS;

  const statuses = Array.isArray(connections)
    ? connections.map((connection) => ({ status: connectionHealth(connection) }))
    : [];
  const statusLine = providersLoading
    ? "Checking provider status…"
    : deriveCommandCenterStatus(
        statuses.map((item) => ({ status: item.status === "off" ? "idle" : item.status })),
      );

  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-medium text-muted lg:text-sm">{statusLine}</p>
        <h1 className="font-display text-2xl font-bold tracking-[-0.02em] text-text lg:text-[42px] lg:leading-[1.05]">
          Command center
        </h1>
      </div>
      <SegmentedControl
        aria-label="Stats period"
        options={options}
        value={period}
        onChange={onPeriodChange}
        className="w-full sm:w-auto lg:shrink-0"
      />
    </div>
  );
}

HomeHeader.propTypes = {
  connections: PropTypes.arrayOf(PropTypes.object),
  providersLoading: PropTypes.bool,
  period: PropTypes.oneOf(["today", "7d", "30d"]).isRequired,
  onPeriodChange: PropTypes.func.isRequired,
};
