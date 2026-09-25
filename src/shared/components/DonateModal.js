"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";
import Modal from "./Modal";
import { Spinner } from "./Loading";
import Button from "./Button";

/**
 * Donation channels loaded from the configured remote JSON. Loaded once open,
 * then cached for the component lifetime.
 *
 * @param {object} props
 * @param {boolean} props.isOpen
 * @param {() => void} props.onClose
 */
export default function DonateModal({ isOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen || data) return;
    setLoading(true);
    setError("");
    fetch(GITHUB_CONFIG.donateUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, data]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <span className="material-symbols-outlined text-coral" aria-hidden="true">
            volunteer_activism
          </span>
          {data?.title || "Support 9Router"}
        </span>
      }
      size="full"
    >
      <div aria-live="polite">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-10 text-muted">
            <Spinner size="sm" />
            Loading...
          </div>
        )}
        {error && (
          <p role="alert" className="py-4 text-err">
            Failed to load donate info: {error}
          </p>
        )}
      </div>
      {!loading && !error && data && (
        <>
          {data.message && <p className="mb-6 text-center text-sm text-muted">{data.message}</p>}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {data.channels?.map((channel) => (
              <DonateChannelCard key={channel.id || channel.label} channel={channel} />
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};

function DonateChannelCard({ channel }) {
  const { label, description, icon, url, qr } = channel;
  return (
    <div className="flex flex-col items-center rounded-xl border border-line bg-raised p-4 transition-colors hover:border-coral/40">
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-coral-bg text-coral">
        <span className="material-symbols-outlined text-[26px]" aria-hidden="true">
          {icon || "volunteer_activism"}
        </span>
      </div>
      <div className="mb-1 font-semibold text-text">{label}</div>
      {description && <div className="mb-3 text-center text-xs text-muted">{description}</div>}
      {qr && (
        // biome-ignore lint/performance/noImgElement: raw img with lazy loading for remote QR images
        <img
          src={qr}
          alt={`${label} QR`}
          className="aspect-square w-full max-w-[180px] rounded-lg bg-white object-contain p-1"
          loading="lazy"
          decoding="async"
        />
      )}
      {url && (
        <Button
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          variant="primary"
          size="sm"
          iconRight="open_in_new"
          className="mt-3"
        >
          Open
        </Button>
      )}
    </div>
  );
}

DonateChannelCard.propTypes = {
  channel: PropTypes.shape({
    id: PropTypes.string,
    label: PropTypes.string,
    description: PropTypes.string,
    icon: PropTypes.string,
    url: PropTypes.string,
    qr: PropTypes.string,
  }).isRequired,
};
