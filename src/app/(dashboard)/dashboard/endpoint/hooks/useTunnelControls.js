"use client";

import { useState, useEffect, useCallback } from "react";
import { isLoginUnsafe as unsafeLogin, canExposeRemote } from "../endpointLogic";
import { readTunnelStatus } from "../remoteAccessLogic";
import { useCloudflareTunnel } from "./useCloudflareTunnel";
import { useTailscale } from "./useTailscale";
import { useDegradedStatusPoll, useReachableSync } from "./useReachableSync";

/**
 * Coordinator for remote access: Cloudflare Tunnel + Tailscale Funnel plus
 * the settings flags that gate remote exposure (requireApiKey, requireLogin,
 * tunnelDashboardAccess). Owns the shared reachable tracking (miss-debounced
 * flips fed by the browser ping), the degraded status poll, and the initial
 * settings + status load. Transport lifecycles live in `useCloudflareTunnel`
 * and `useTailscale`; this hook wires them together and preserves the exact
 * public shape the endpoint page consumes.
 *
 * Trust user intent (`settingsEnabled`): UI stays "enabled" while the
 * watchdog restarts the backend process.
 *
 * @returns {object} All tunnel/tailscale/settings state, modal booleans,
 * handlers, and the `canEnableRemote` / `isLoginUnsafe` / gate-note derivations.
 */
export function useTunnelControls() {
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);

  const tunnel = useCloudflareTunnel();
  const ts = useTailscale();

  // Security gate derivations (shared pure logic).
  const isLoginUnsafe = unsafeLogin({ requireLogin, hasPassword });
  const canEnableRemote = canExposeRemote({ requireLogin, hasPassword, requireApiKey });
  const unsafeReason = !requireLogin
    ? 'Enable "Require login" and set a custom password before activating the tunnel.'
    : "Change the default dashboard password before activating the tunnel.";
  const gateNote = !requireApiKey ? "Requires API key to be on." : unsafeReason;

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process
  const syncTunnelStatus = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      const parsed = readTunnelStatus(data);
      tunnel.setUrl(parsed.tunnel.url);
      tunnel.setPublicUrl(parsed.tunnel.publicUrl);
      tunnel.setEnabled(parsed.tunnel.enabled);
      ts.setUrl(parsed.tailscale.url);
      ts.setEnabled(parsed.tailscale.enabled);
    } catch {
      /* ignore poll errors */
    }
  }, [tunnel, ts]);

  const loadSettings = useCallback(async () => {
    tunnel.setChecking(true);
    try {
      const [settingsRes, statusRes] = await Promise.all([
        fetch("/api/settings"),
        fetch("/api/tunnel/status", { cache: "no-store" }),
      ]);
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setRequireApiKey(data.requireApiKey || false);
        setRequireLogin(data.requireLogin !== false);
        setHasPassword(data.hasPassword || false);
        setTunnelDashboardAccess(data.tunnelDashboardAccess || false);
      }
      if (statusRes.ok) {
        const data = await statusRes.json();
        const parsed = readTunnelStatus(data);
        tunnel.setUrl(parsed.tunnel.url);
        tunnel.setPublicUrl(parsed.tunnel.publicUrl);
        tunnel.setEnabled(parsed.tunnel.enabled);
        ts.setUrl(parsed.tailscale.url);
        ts.setEnabled(parsed.tailscale.enabled);
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      tunnel.setChecking(false);
    }
  }, [tunnel, ts]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Shared reachable tracking + browser ping (one tracker per transport).
  useReachableSync({
    tunnel: {
      enabled: tunnel.enabled,
      reachable: tunnel.reachable,
      url: tunnel.url,
      publicUrl: tunnel.publicUrl,
    },
    setTunnel: tunnel.applyReachablePatch,
    tailscale: { enabled: ts.enabled, reachable: ts.reachable, url: ts.url },
    setTailscale: ts.applyReachablePatch,
  });

  // Status poll only while degraded; stops once healthy.
  useDegradedStatusPoll({
    anyEnabled: tunnel.enabled || ts.enabled,
    allHealthy: (!tunnel.enabled || tunnel.reachable) && (!ts.enabled || ts.reachable),
    onSync: syncTunnelStatus,
  });

  const handleTunnelDashboardAccess = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tunnelDashboardAccess: value }),
      });
      if (res.ok) setTunnelDashboardAccess(value);
    } catch (error) {
      console.log("Error updating tunnelDashboardAccess:", error);
    }
  };

  const handleRequireApiKey = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireApiKey: value }),
      });
      if (res.ok) setRequireApiKey(value);
    } catch (error) {
      console.log("Error updating requireApiKey:", error);
    }
  };

  const handleRequireLogin = async (value) => {
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requireLogin: value }),
      });
      if (res.ok) setRequireLogin(value);
    } catch (error) {
      console.log("Error updating requireLogin:", error);
    }
  };

  return {
    // settings
    requireApiKey,
    requireLogin,
    hasPassword,
    tunnelDashboardAccess,
    handleRequireApiKey,
    handleRequireLogin,
    handleTunnelDashboardAccess,
    loadSettings,
    // derivations
    isLoginUnsafe,
    canEnableRemote,
    unsafeReason,
    gateNote,
    // tunnel
    tunnelChecking: tunnel.checking,
    setTunnelChecking: tunnel.setChecking,
    tunnelEnabled: tunnel.enabled,
    tunnelReachable: tunnel.reachable,
    tunnelEverReachable: tunnel.everReachable,
    tunnelUrl: tunnel.url,
    tunnelPublicUrl: tunnel.publicUrl,
    tunnelLoading: tunnel.loading,
    setTunnelLoading: tunnel.setTunnelLoading,
    tunnelProgress: tunnel.progress,
    setTunnelProgress: tunnel.setTunnelProgress,
    tunnelStatus: tunnel.status,
    setTunnelStatus: tunnel.setStatus,
    showEnableTunnelModal: tunnel.showEnableModal,
    setShowEnableTunnelModal: tunnel.setShowEnableModal,
    showDisableTunnelModal: tunnel.showDisableModal,
    setShowDisableTunnelModal: tunnel.setShowDisableModal,
    syncTunnelStatus,
    handleEnableTunnel: tunnel.enableTunnel,
    handleDisableTunnel: tunnel.disableTunnel,
    // tailscale
    tsEnabled: ts.enabled,
    tsReachable: ts.reachable,
    tsEverReachable: ts.everReachable,
    tsUrl: ts.url,
    tsLoading: ts.loading,
    setTsLoading: ts.setTsLoading,
    tsProgress: ts.progress,
    setTsProgress: ts.setTsProgress,
    tsStatus: ts.status,
    setTsStatus: ts.setStatus,
    tsAuthUrl: ts.authUrl,
    tsAuthLabel: ts.authLabel,
    tsInstalled: ts.installed,
    tsInstalling: ts.installing,
    tsInstallLog: ts.installLog,
    tsSudoPassword: ts.sudoPassword,
    setTsSudoPassword: ts.setSudoPassword,
    tsConnecting: ts.connecting,
    setTsConnecting: ts.setTsConnecting,
    showTsModal: ts.showModal,
    setShowTsModal: ts.setShowModal,
    showDisableTsModal: ts.showDisableModal,
    setShowDisableTsModal: ts.setShowDisableModal,
    tsLogRef: ts.logRef,
    checkTailscaleInstalled: ts.checkInstalled,
    handleInstallTailscale: ts.installTailscale,
    handleConnectTailscale: ts.connectTailscale,
    handleDisableTailscale: ts.disableTailscale,
    handleOpenTsModal: ts.openModal,
    pollFunnelEnable: () => Promise.resolve(),
    requestUserAuth: ts.requestUserAuth,
    clearUserAuth: ts.clearUserAuth,
    updateReachable: () => {},
  };
}
