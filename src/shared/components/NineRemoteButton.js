"use client";

import NineRemotePromoModal from "./NineRemotePromoModal";
import { useState } from "react";

/** Header-style button that opens the 9Remote promo modal. */
export default function NineRemoteButton() {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="relative flex h-11 items-center gap-1.5 rounded-lg px-2.5 text-muted transition-all hover:bg-raised hover:text-text"
        title="9Remote"
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          computer
        </span>
        <span className="text-xs font-medium">Remote</span>
      </button>
      <NineRemotePromoModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
