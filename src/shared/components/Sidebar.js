"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { APP_CONFIG } from "@/shared/constants/config";
import { useShellStatus } from "@/shared/hooks";
import SidebarNav from "./SidebarNav";
import GatewayStatusCard from "./GatewayStatusCard";
import SidebarUserRow from "./SidebarUserRow";
import NineRemotePromoModal from "./NineRemotePromoModal";
import IconButton from "./IconButton";

/**
 * Signal sidebar per the board: 248px width, panel background, 1px line
 * border. Top to bottom:
 * - Logo: tilted coral "9" tile, "router" wordmark, mono version chip
 * - Gateway status card: pulsing lime dot, online state, port line
 * - Grouped nav with badges via useShellStatus
 * - "More" links: 9Remote promo modal + 9English external link preserved
 * - User row with theme toggle, language modal and logout menu
 *
 * @param {object} props
 * @param {() => void} [props.onClose] Called on mobile navigation to close the drawer.
 * @param {boolean} [props.inDrawer=false] Adjusts container styling when rendered inside a Drawer.
 */
export default function Sidebar({ onClose, inDrawer = false }) {
  const [remoteOpen, setRemoteOpen] = useState(false);
  const { loading, gatewayOnline, port, startedAt, badges, enableTranslator } = useShellStatus();

  return (
    <>
      <aside
        className={
          inDrawer
            ? "flex h-full min-h-0 w-full flex-col gap-5 bg-panel px-4 pt-6 pb-4 text-text"
            : "flex h-full min-h-0 w-[248px] shrink-0 flex-col gap-5 border-e border-line bg-panel px-4 pt-6 pb-4 text-text"
        }
      >
        {/* Logo block */}
        <div className="flex items-center gap-2.5 px-2">
          <Link
            href="/dashboard"
            onClick={onClose}
            className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span
              className="-rotate-[8deg] flex size-9 items-center justify-center rounded-[11px] bg-coral font-display text-[22px] font-extrabold text-on-coral shadow-card"
              aria-hidden="true"
            >
              9
            </span>
            <span className="font-display text-[22px] font-bold tracking-[-0.02em] text-text">
              router
            </span>
          </Link>
          <span className="ms-auto rounded-md border border-line px-1.5 py-0.5 font-mono text-[11px] text-muted">
            v{APP_CONFIG.version}
          </span>
          {inDrawer && onClose ? (
            <IconButton icon="close" label="Close navigation" onClick={onClose} />
          ) : null}
        </div>

        {/* Gateway status card */}
        <GatewayStatusCard
          loading={loading}
          online={gatewayOnline}
          port={port}
          startedAt={startedAt}
        />

        {/* Grouped navigation */}
        <SidebarNav enableTranslator={enableTranslator} badges={badges} onNavigate={onClose} />

        {/* More links (9Remote + 9English preserved per spec) */}
        <div className="flex flex-col gap-0.5 border-t border-line px-1 pt-2">
          <button
            type="button"
            onClick={() => setRemoteOpen(true)}
            className="flex h-8 items-center gap-3 rounded-[10px] px-2 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              computer
            </span>
            <span className="flex-1 text-start">9Remote</span>
          </button>
          <a
            href="https://9english.net/"
            target="_blank"
            rel="noreferrer"
            onClick={onClose}
            className="flex h-8 items-center gap-3 rounded-[10px] px-2 text-xs font-medium text-muted transition-colors hover:bg-raised hover:text-text focus-visible:outline-none focus-visible:shadow-focus"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              translate
            </span>
            <span className="flex-1 text-start">9English</span>
            <span className="material-symbols-outlined text-[14px] text-subtle" aria-hidden="true">
              open_in_new
            </span>
          </a>
        </div>

        {/* User row */}
        <SidebarUserRow />
      </aside>

      <NineRemotePromoModal isOpen={remoteOpen} onClose={() => setRemoteOpen(false)} />
    </>
  );
}

Sidebar.propTypes = {
  onClose: PropTypes.func,
  inDrawer: PropTypes.bool,
};
