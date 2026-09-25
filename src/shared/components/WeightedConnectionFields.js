"use client";

import PropTypes from "prop-types";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";
import { formatPlanTier } from "@/shared/constants/accountStrategies";

// Select renders its own disabled "" placeholder, so Auto needs a distinct sentinel.
const AUTO_PLAN = "__auto__";
const WEIGHT_HINT =
  "Blank = derive from plan and quota. 0 skips this account unless it is the only one available.";

export default function WeightedConnectionFields({
  planOptions,
  planTier,
  onPlanTierChange,
  autoPlanLabel,
  weight,
  onWeightChange,
  weightError,
}) {
  const tiers = planOptions ? Object.keys(planOptions) : [];
  return (
    <>
      {tiers.length > 0 && (
        <Select
          label="Plan"
          aria-label="Plan"
          value={planTier || AUTO_PLAN}
          onChange={(e) => onPlanTierChange(e.target.value === AUTO_PLAN ? "" : e.target.value)}
          placeholder="Plan"
          options={[
            { value: AUTO_PLAN, label: autoPlanLabel },
            ...tiers.map((tier) => ({ value: tier, label: formatPlanTier(tier) })),
          ]}
        />
      )}
      <Input
        label="Weight override"
        aria-label="Weight override"
        type="number"
        min={0}
        max={1000}
        step="any"
        value={weight}
        onChange={(e) => onWeightChange(e.target.value)}
        placeholder="Auto"
        hint={WEIGHT_HINT}
        error={weightError}
      />
    </>
  );
}

WeightedConnectionFields.propTypes = {
  planOptions: PropTypes.object,
  planTier: PropTypes.string.isRequired,
  onPlanTierChange: PropTypes.func.isRequired,
  autoPlanLabel: PropTypes.string.isRequired,
  weight: PropTypes.string.isRequired,
  onWeightChange: PropTypes.func.isRequired,
  weightError: PropTypes.string,
};
