"use client";

import PropTypes from "prop-types";
import { getProviderBrand } from "@/shared/constants/providerBrands";

const SIZES = {
  sm: "size-6 text-[10px] rounded-md",
  md: "size-9 text-sm rounded-[10px]",
  lg: "size-14 text-lg rounded-[14px]",
};

const STATUS_RING = {
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err",
  info: "bg-sky",
  live: "bg-lime",
  neutral: "bg-line",
};

/**
 * Signal provider monogram tile on the provider's brand color.
 *
 * @param {object} props
 * @param {string} props.providerId Provider id (registry) or brand key.
 * @param {"sm"|"md"|"lg"} [props.size="md"] sm 24, md 36, lg 56.
 * @param {"ok"|"warn"|"err"|"info"|"live"|"neutral"} [props.status] Optional status dot with panel ring.
 * @param {string} [props.className]
 */
export default function ProviderTile({ providerId, size = "md", status, className }) {
  const tile = SIZES[size];
  if (!tile) throw new Error(`ProviderTile: unknown size "${size}"`);
  if (status !== undefined && !STATUS_RING[status]) {
    throw new Error(`ProviderTile: unknown status "${status}"`);
  }
  const brand = getProviderBrand(providerId);

  return (
    <span
      aria-hidden="true"
      title={providerId}
      style={{ backgroundColor: brand.color }}
      className={`relative inline-flex shrink-0 items-center justify-center font-display font-bold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.14)] ${tile}${className ? ` ${className}` : ""}`}
    >
      {brand.monogram}
      {status && (
        <span
          className={`absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full shadow-[0_0_0_2px_var(--signal-panel)] ${STATUS_RING[status]}`}
        />
      )}
    </span>
  );
}

ProviderTile.propTypes = {
  providerId: PropTypes.string.isRequired,
  size: PropTypes.oneOf(Object.keys(SIZES)),
  status: PropTypes.oneOf(Object.keys(STATUS_RING)),
  className: PropTypes.string,
};
