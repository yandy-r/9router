"use client";

import PropTypes from "prop-types";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CardSkeleton } from "@/shared/components";
import StatusPill from "@/shared/components/StatusPill";
import { getToolBrand } from "../lib/toolStatus";

/**
 * "Intercept tools" section: IDE tools that cannot change their endpoint, so
 * 9router reroutes them via the MITM proxy. Shows live on/off status per
 * tool from /api/cli-tools/antigravity-mitm and links to the MITM setup.
 *
 * @param {object} props
 * @param {Array<[string, object]>} props.tools [toolId, MITM_TOOLS entry] pairs.
 */
export default function InterceptTools({ tools }) {
  const [dnsStatus, setDnsStatus] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/cli-tools/antigravity-mitm");
        if (res.ok && mounted) {
          const data = await res.json();
          setDnsStatus(data.running ? data.dnsStatus || {} : null);
        } else if (mounted) {
          setDnsStatus({});
        }
      } catch {
        if (mounted) setDnsStatus({});
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (!tools || tools.length === 0) return null;

  return (
    <section aria-labelledby="intercept-tools-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <h2
          id="intercept-tools-heading"
          className="font-display text-xl font-bold tracking-[-0.02em] text-text"
        >
          Intercept tools
        </h2>
        <p className="text-[13px] text-muted">
          For IDEs that can’t change their endpoint, 9router listens in (MITM) and reroutes.
        </p>
      </div>
      {dnsStatus === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {tools.map(([toolId, tool]) => {
            const on = !!dnsStatus[toolId];
            const brand = getToolBrand(tool);
            return (
              <Link
                key={toolId}
                href="/dashboard/mitm"
                aria-label={`${tool.name} — MITM ${on ? "on" : "off"}. Open MITM setup.`}
                className="flex min-h-11 items-center gap-3 rounded-2xl border border-line bg-panel p-4 shadow-card transition-colors duration-150 hover:border-subtle focus-visible:outline-none focus-visible:shadow-focus motion-reduce:transition-none"
              >
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: brand.color }}
                  className="flex size-9 shrink-0 items-center justify-center rounded-[10px] font-display text-sm font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)]"
                >
                  {brand.monogram}
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[15px] font-semibold text-text">{tool.name}</span>
                  <span className="truncate text-[13px] text-muted">{tool.description}</span>
                </span>
                <StatusPill variant={on ? "ok" : "neutral"} size="sm" dot={on}>
                  {on ? "On" : "Off"}
                </StatusPill>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

InterceptTools.propTypes = {
  tools: PropTypes.arrayOf(
    PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.string, PropTypes.object])).isRequired,
  ),
};
