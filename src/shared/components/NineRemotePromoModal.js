"use client";

import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";

const FEATURES = [
  { icon: "terminal", label: "Terminal", desc: "Full shell access" },
  { icon: "cast", label: "Desktop", desc: "Screen sharing" },
  { icon: "folder_open", label: "Files", desc: "Browse & edit files" },
];

const BULLETS = [
  { icon: "qr_code_scanner", text: "Scan QR to connect instantly" },
  { icon: "wifi_off", text: "No port forwarding needed" },
  { icon: "devices", text: "Works on any device" },
];

const NINE_REMOTE_URL = "https://9remote.cc";

/**
 * 9Remote promotion dialog: features, install bullets and external call to
 * action. Uses the shared modal for Escape, focus trap and scroll lock.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 */
export default function NineRemotePromoModal({ isOpen, onClose }) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-3">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary-fill">
            <span className="material-symbols-outlined text-base text-on-coral" aria-hidden="true">
              terminal
            </span>
          </span>
          <span className="font-mono text-xs font-bold uppercase tracking-wider text-primary">
            9Remote
          </span>
        </span>
      }
    >
      <div className="flex flex-col gap-6">
        <div className="mt-2 flex flex-col items-center gap-2 text-center">
          <div className="mb-1 flex size-14 items-center justify-center rounded-xl bg-primary-fill shadow-card">
            <span
              className="material-symbols-outlined text-[30px] text-on-coral"
              aria-hidden="true"
            >
              terminal
            </span>
          </div>
          <h2 className="text-lg font-bold tracking-tight text-text">9Remote</h2>
          <p className="max-w-[220px] text-xs leading-5 text-muted">
            Access your terminal, desktop &amp; files from anywhere
          </p>
        </div>

        <div className="flex w-full gap-2">
          {FEATURES.map(({ icon, label, desc }) => (
            <div
              key={label}
              className="flex flex-1 flex-col items-center gap-1.5 rounded-lg border border-line bg-raised px-1 py-4"
            >
              <span
                className="material-symbols-outlined text-[22px] text-primary"
                aria-hidden="true"
              >
                {icon}
              </span>
              <p className="text-xs font-semibold text-text">{label}</p>
              <p className="text-center text-[10px] leading-4 text-muted">{desc}</p>
            </div>
          ))}
        </div>

        <div className="flex w-full flex-col gap-3">
          {BULLETS.map(({ icon, text }) => (
            <div key={icon} className="flex items-center gap-2.5">
              <span
                className="material-symbols-outlined shrink-0 text-[16px] text-primary"
                aria-hidden="true"
              >
                {icon}
              </span>
              <span className="text-xs text-muted">{text}</span>
            </div>
          ))}
        </div>

        <Button
          variant="primary"
          icon="open_in_new"
          onClick={() => window.open(NINE_REMOTE_URL, "_blank")}
        >
          Get 9Remote
        </Button>
      </div>
    </Modal>
  );
}

NineRemotePromoModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
