"use client";

import PropTypes from "prop-types";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import { Skeleton } from "@/shared/components/Loading";

/**
 * Widget frame: one loading skeleton, one guided empty state, one error callout.
 * Every Home widget renders through this so states stay consistent.
 */
export function WidgetSkeleton({ lines = 4, label = "Loading" }) {
  return (
    <div role="status" aria-label={label} className="flex min-w-0 flex-col gap-3">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-9 w-2/3" />
      {Array.from({ length: lines }, (_, position) => `home-skel-${position}`).map((id) => (
        <Skeleton key={id} className="h-4 w-full" />
      ))}
    </div>
  );
}

WidgetSkeleton.propTypes = {
  lines: PropTypes.number,
  label: PropTypes.string,
};

/**
 * Guided empty state with a single CTA to the page that fixes the gap.
 * @param {object} props
 * @param {string} props.icon Material Symbols icon name.
 * @param {string} props.title
 * @param {string} props.body
 * @param {string} props.actionLabel
 * @param {string} props.actionHref
 */
export function WidgetEmpty({ icon, title, body, actionLabel, actionHref }) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-3 py-2">
      <span className="flex size-10 items-center justify-center rounded-[10px] bg-raised text-muted">
        <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
          {icon}
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-text">{title}</p>
        <p className="mt-1 text-sm text-muted">{body}</p>
      </div>
      <Button variant="secondary" size="sm" href={actionHref} icon="arrow_forward">
        {actionLabel}
      </Button>
    </div>
  );
}

WidgetEmpty.propTypes = {
  icon: PropTypes.string.isRequired,
  title: PropTypes.string.isRequired,
  body: PropTypes.string.isRequired,
  actionLabel: PropTypes.string.isRequired,
  actionHref: PropTypes.string.isRequired,
};

/**
 * Error state: the real failure message plus a retry action.
 * @param {object} props
 * @param {string} props.message backend error text (already user-safe)
 * @param {() => void} props.onRetry
 */
export function WidgetError({ message, onRetry }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Callout variant="err" title="Could not load this widget">
        {message || "Something went wrong while loading."}
      </Callout>
      <div>
        <Button variant="secondary" size="sm" icon="refresh" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

WidgetError.propTypes = {
  message: PropTypes.string,
  onRetry: PropTypes.func.isRequired,
};
