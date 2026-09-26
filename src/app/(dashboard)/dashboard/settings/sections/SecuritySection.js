"use client";

import PropTypes from "prop-types";
import { useState } from "react";
import SectionCard from "@/shared/components/SectionCard";
import SettingRow from "@/shared/components/SettingRow";
import Toggle from "@/shared/components/Toggle";
import Input from "@/shared/components/Input";
import Button from "@/shared/components/Button";
import Callout from "@/shared/components/Callout";
import { useSettingsField } from "../useSettingsField";

/**
 * Security & access section:
 * - requireLogin: optimistic toggle with rollback
 * - password change: current/new/confirm with client & server validation
 * - requireApiKey: optimistic toggle
 * - tunnelDashboardAccess: optimistic toggle
 */
export default function SecuritySection({ settings, onSettingsChange }) {
  // Report to the page only after the server accepted the value (drives "All changes saved").
  const onSaved = (key) => (value) => onSettingsChange?.({ [key]: value });
  const requireLoginField = useSettingsField("requireLogin", settings.requireLogin !== false, {
    onSaved: onSaved("requireLogin"),
  });
  const requireApiKeyField = useSettingsField("requireApiKey", settings.requireApiKey !== false, {
    onSaved: onSaved("requireApiKey"),
  });
  const tunnelAccessField = useSettingsField(
    "tunnelDashboardAccess",
    settings.tunnelDashboardAccess !== false,
    { onSaved: onSaved("tunnelDashboardAccess") },
  );

  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [passStatus, setPassStatus] = useState({ type: "", message: "" });
  const [passLoading, setPassLoading] = useState(false);

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (passwords.next !== passwords.confirm) {
      setPassStatus({ type: "err", message: "Passwords do not match" });
      return;
    }
    if (!passwords.next) {
      setPassStatus({ type: "err", message: "New password cannot be empty" });
      return;
    }
    setPassLoading(true);
    setPassStatus({ type: "", message: "" });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwords.current,
          newPassword: passwords.next,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPassStatus({ type: "ok", message: "Password updated successfully" });
        setPasswords({ current: "", next: "", confirm: "" });
        onSettingsChange?.({ hasPassword: true });
      } else {
        setPassStatus({ type: "err", message: data.error || "Failed to update password" });
      }
    } catch {
      setPassStatus({ type: "err", message: "An error occurred while updating password" });
    } finally {
      setPassLoading(false);
    }
  };

  return (
    <div id="security" className="scroll-mt-24 space-y-4">
      <SectionCard
        icon="shield"
        title="Security & access"
        subtitle="Who can reach the dashboard and the API."
        status="ok"
        statusLabel="Protected"
      />
      <div className="rounded-2xl border border-line bg-panel p-5 shadow-card divide-y divide-line">
        <SettingRow
          label="Require login"
          description="Ask for the dashboard password first."
          settingKey="requireLogin"
          control={
            <Toggle
              checked={requireLoginField.value}
              onChange={(next) => requireLoginField.set(next)}
              disabled={requireLoginField.saving}
              aria-label="Require login"
            />
          }
        />
        {requireLoginField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {requireLoginField.error}
          </p>
        )}

        {/* Password change form */}
        <div className="py-4 space-y-4">
          <div>
            <p className="text-[15px] font-semibold text-text">Password</p>
            <p className="mt-0.5 text-[13px] text-muted">
              Change the dashboard password. Replace the default before exposing anything.
            </p>
          </div>
          <form onSubmit={handlePasswordSubmit} className="space-y-3 max-w-xl">
            {settings.hasPassword && (
              <Input
                label="Current password"
                type="password"
                autoComplete="current-password"
                value={passwords.current}
                onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
                required
                disabled={passLoading}
                placeholder="Current password"
              />
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Input
                label="New password"
                type="password"
                autoComplete="new-password"
                value={passwords.next}
                onChange={(e) => setPasswords((p) => ({ ...p, next: e.target.value }))}
                required
                disabled={passLoading}
                placeholder="New password"
              />
              <Input
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                value={passwords.confirm}
                onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))}
                required
                disabled={passLoading}
                placeholder="Confirm password"
              />
            </div>
            {passStatus.message && (
              <Callout
                variant={passStatus.type === "ok" ? "ok" : "err"}
                title={passStatus.message}
              />
            )}
            <Button
              type="submit"
              loading={passLoading}
              disabled={passLoading || settings.hasPassword === undefined}
            >
              {settings.hasPassword ? "Update password" : "Set password"}
            </Button>
          </form>
        </div>

        <SettingRow
          label="Require API key"
          description="Requests without a valid key get a 401. Needed for the tunnel."
          settingKey="requireApiKey"
          control={
            <Toggle
              checked={requireApiKeyField.value}
              onChange={(next) => requireApiKeyField.set(next)}
              disabled={requireApiKeyField.saving}
              aria-label="Require API key"
            />
          }
        />
        {requireApiKeyField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {requireApiKeyField.error}
          </p>
        )}

        <SettingRow
          label="Dashboard over tunnel"
          description="Serve this dashboard on the public tunnel URL too."
          settingKey="tunnelDashboardAccess"
          control={
            <Toggle
              checked={tunnelAccessField.value}
              onChange={(next) => tunnelAccessField.set(next)}
              disabled={tunnelAccessField.saving}
              aria-label="Dashboard over tunnel"
            />
          }
        />
        {tunnelAccessField.error && (
          <p className="py-2 text-xs text-err" role="alert">
            {tunnelAccessField.error}
          </p>
        )}
      </div>
    </div>
  );
}

SecuritySection.propTypes = {
  settings: PropTypes.object.isRequired,
  onSettingsChange: PropTypes.func,
};
