"use client";

import PropTypes from "prop-types";
import { useId } from "react";
import { cn } from "@/shared/utils/cn";

/** Signal checkbox: native input, coral check, 22px box in a 44px hit area. */
export default function Checkbox({
  checked = false,
  onChange,
  label,
  description,
  disabled = false,
  className,
  id,
  ...props
}) {
  const generatedId = useId();
  const inputId = id || generatedId;

  return (
    <div className={cn("flex items-start gap-3", disabled && "opacity-50", className)}>
      <span className="inline-flex min-h-11 min-w-11 items-center justify-center -ms-2.5">
        <input
          {...props}
          id={inputId}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange?.(event.target.checked)}
          disabled={disabled}
          className={cn(
            "size-[22px] shrink-0 cursor-pointer appearance-none rounded-md border border-line bg-raised",
            "transition-colors duration-150 checked:border-transparent checked:bg-coral",
            "checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 16 16%27><path d=%27M3.5 8.5l3.5 3.5 5.5-7%27 fill=%27none%27 stroke=%27white%27 stroke-width=%272%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/></svg>')] checked:bg-center checked:bg-no-repeat",
            "focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed",
          )}
        />
      </span>
      {(label || description) && (
        <label htmlFor={inputId} className="flex flex-col cursor-pointer pt-2">
          {label && <span className="text-sm font-medium text-text">{label}</span>}
          {description && <span className="text-xs text-muted">{description}</span>}
        </label>
      )}
    </div>
  );
}

Checkbox.propTypes = {
  checked: PropTypes.bool,
  onChange: PropTypes.func,
  label: PropTypes.node,
  description: PropTypes.node,
  disabled: PropTypes.bool,
  className: PropTypes.string,
  id: PropTypes.string,
};
