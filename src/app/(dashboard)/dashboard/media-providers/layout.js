"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { usePathname } from "next/navigation";
import { MEDIA_TABS } from "@/shared/constants/navigation";
import { cn } from "@/shared/utils/cn";

/**
 * Minimal media providers layout (YAN-279 shell).
 * Renders an accessible tab nav (links, aria-current) across visible kinds
 * plus "Web fetch & search" above children. YAN-305 will redesign this page.
 *
 * @param {object} props
 * @param {React.ReactNode} props.children
 */
export default function MediaProvidersLayout({ children }) {
  const pathname = usePathname() || "";

  const isTabActive = (href) => {
    if (!pathname) return false;
    if (href.endsWith("/web")) {
      return pathname === href || pathname.startsWith("/dashboard/media-providers/web");
    }
    if (pathname === href || pathname.startsWith(`${href}/`)) return true;
    return false;
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <nav aria-label="Media providers" className="flex flex-wrap items-center gap-1">
        {MEDIA_TABS.map((tab) => {
          const active = isTabActive(tab.href);
          return (
            <Link
              key={tab.id}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                active ? "bg-coral-bg font-semibold text-coral-ink" : "text-muted hover:text-text",
              )}
            >
              <span
                className={cn("material-symbols-outlined text-[18px]", active && "fill-1")}
                aria-hidden="true"
              >
                {tab.icon}
              </span>
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

MediaProvidersLayout.propTypes = {
  children: PropTypes.node,
};
