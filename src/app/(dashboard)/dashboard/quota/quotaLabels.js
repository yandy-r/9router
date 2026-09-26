import { getConnectionLabel as getProviderLimitsLabel } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

/**
 * Primary account label: name, else email, else display name.
 * Single implementation shared with the legacy ProviderLimits view —
 * re-exported here so the Quota page never drifts from it.
 */
export const getConnectionLabel = getProviderLimitsLabel;

/**
 * Secondary account label: the email when it differs from the name, else the
 * display name when it differs from the name.
 *
 * @param {{name?: string, email?: string, displayName?: string}} connection
 * @returns {string|null}
 */
export function getConnectionSecondaryLabel(connection) {
  if (!connection) return null;
  if (
    connection.name?.trim() &&
    connection.email?.trim() &&
    connection.name.trim() !== connection.email.trim()
  ) {
    return connection.email.trim();
  }
  if (
    connection.name?.trim() &&
    connection.displayName?.trim() &&
    connection.name.trim() !== connection.displayName.trim()
  ) {
    return connection.displayName.trim();
  }
  return null;
}
