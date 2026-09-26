"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { isLoginUnsafe as unsafeLogin, canExposeRemote } from "../endpointLogic";
import {
  TUNNEL_PING_INTERVAL_MS,
  TUNNEL_PING_MAX_MS,
  STATUS_POLL_FAST_MS,
  REACHABLE_MISS_THRESHOLD,
  CLIENT_PING_FAST_MS,
} from "../endpointConstants";
import { clientPingUrl, clientPingAny } from "../endpointPing";

/**
 * Cloudflare Tunnel + Tailscale Funnel state machine plus the settings flags
 * that gate remote exposure (requireApiKey, requireLogin, tunnelDashboardAccess).
 * Extracted verbatim-behavior from EndpointPageClient: miss-debounced reachable
 * flips, browser-side ping (immune to backend DNS quirks), tunnel/Funnel
 * health polling, SSE install streaming, and the login / Funnel-enable wait
 * loops. Popups open only from explicit user clicks — requestUserAuth stashes
 * the URL and the view renders the button.
 *
 * @returns {object} All tunnel/tailscale/settings state, modal booleans,
 * handlers, and the `canEnableRemote` / `isLoginUnsafe` / gate-note derivations.
 */
export function useTunnelControls() {
  const [requireApiKey, setRequireApiKey] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [hasPassword, setHasPassword] = useState(true);
  const [tunnelDashboardAccess, setTunnelDashboardAccess] = useState(false);

  // Cloudflare Tunnel state
  const [tunnelChecking, setTunnelChecking] = useState(true);
  const [tunnelEnabled, setTunnelEnabled] = useState(false);
  const [tunnelReachable, setTunnelReachable] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState("");
  const [tunnelPublicUrl, setTunnelPublicUrl] = useState("");
  const [tunnelLoading, setTunnelLoading] = useState(false);
  const [tunnelProgress, setTunnelProgress] = useState("");
  const [tunnelStatus, setTunnelStatus] = useState(null);
  const [showEnableTunnelModal, setShowEnableTunnelModal] = useState(false);
  const [showDisableTunnelModal, setShowDisableTunnelModal] = useState(false);

  // Tailscale state
  const [tsEnabled, setTsEnabled] = useState(false);
  const [tsReachable, setTsReachable] = useState(false);
  const [tsUrl, setTsUrl] = useState("");
  const [tsLoading, setTsLoading] = useState(false);
  const [tsProgress, setTsProgress] = useState("");
  const [tsStatus, setTsStatus] = useState(null);
  const [tsAuthUrl, setTsAuthUrl] = useState("");
  const [tsAuthLabel, setTsAuthLabel] = useState("");
  const [tsInstalled, setTsInstalled] = useState(null); // null=checking, true/false
  const [tsInstalling, setTsInstalling] = useState(false);
  const [tsInstallLog, setTsInstallLog] = useState([]);
  const [tsSudoPassword, setTsSudoPassword] = useState("");
  const [tsConnecting, setTsConnecting] = useState(false);
  const [showTsModal, setShowTsModal] = useState(false);
  const [showDisableTsModal, setShowDisableTsModal] = useState(false);
  const tsLogRef = useRef(null);

  // Debounce reachable=false: server may briefly return false during background refresh.
  const tunnelMissRef = useRef(0);
  const tsMissRef = useRef(0);
  const tunnelClientReachableRef = useRef(false);
  const tsClientReachableRef = useRef(false);
  // Track whether reachable=true was ever observed: distinguishes
  // "Checking..." (initial cold cache) from "Reconnecting..." (lost connection).
  const tunnelEverReachableRef = useRef(false);
  const tsEverReachableRef = useRef(false);
  const [tunnelEverReachable, setTunnelEverReachable] = useState(false);
  const [tsEverReachable, setTsEverReachable] = useState(false);

  // Security gate derivations (shared pure logic).
  const isLoginUnsafe = unsafeLogin({ requireLogin, hasPassword });
  const canEnableRemote = canExposeRemote({ requireLogin, hasPassword, requireApiKey });
  const unsafeReason = !requireLogin
    ? 'Enable "Require login" and set a custom password before activating the tunnel.'
    : "Change the default dashboard password before activating the tunnel.";
  const gateNote = !requireApiKey ? "Requires API key to be on." : unsafeReason;

  // Auto-scroll install log
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll effect only; ref reads are DOM sync, not reactive inputs.
  useEffect(() => {
    if (tsLogRef.current) tsLogRef.current.scrollTop = tsLogRef.current.scrollHeight;
  }, [tsInstallLog]);

  // Miss-debounce helper used by the sync/ping sites below.
  const updateReachable = useCallback(
    (_unused, clientRef, missRef, setter, everRef, everSetter) => {
      const reachable = clientRef.current;
      if (reachable) {
        missRef.current = 0;
        setter(true);
        if (!everRef.current) {
          everRef.current = true;
          everSetter(true);
        }
      } else {
        missRef.current += 1;
        if (missRef.current >= REACHABLE_MISS_THRESHOLD) setter(false);
      }
    },
    [],
  );

  // Trust user intent (settingsEnabled): UI stays "enabled" while watchdog restarts process.
  const syncTunnelStatus = useCallback(async () => {
    try {
      const statusRes = await fetch("/api/tunnel/status", { cache: "no-store" });
      if (!statusRes.ok) return;
      const data = await statusRes.json();
      const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
      setTunnelUrl(data.tunnel?.tunnelUrl || "");
      setTunnelPublicUrl(data.tunnel?.publicUrl || "");
      setTunnelEnabled(tEnabled);
      // Reachable derived from the client refs (set by the browser ping effect).
      if (tunnelClientReachableRef.current) {
        tunnelMissRef.current = 0;
        setTunnelReachable(true);
        if (!tunnelEverReachableRef.current) {
          tunnelEverReachableRef.current = true;
          setTunnelEverReachable(true);
        }
      } else {
        tunnelMissRef.current += 1;
        if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false);
      }
      const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
      setTsUrl(data.tailscale?.tunnelUrl || "");
      setTsEnabled(tsEn);
      if (tsClientReachableRef.current) {
        tsMissRef.current = 0;
        setTsReachable(true);
        if (!tsEverReachableRef.current) {
          tsEverReachableRef.current = true;
          setTsEverReachable(true);
        }
      } else {
        tsMissRef.current += 1;
        if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false);
      }
    } catch {
      /* ignore poll errors */
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setTunnelChecking(true);
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
        const tEnabled = data.tunnel?.settingsEnabled ?? data.tunnel?.enabled ?? false;
        setTunnelUrl(data.tunnel?.tunnelUrl || "");
        setTunnelPublicUrl(data.tunnel?.publicUrl || "");
        setTunnelEnabled(tEnabled);
        if (tunnelClientReachableRef.current) {
          tunnelMissRef.current = 0;
          setTunnelReachable(true);
          if (!tunnelEverReachableRef.current) {
            tunnelEverReachableRef.current = true;
            setTunnelEverReachable(true);
          }
        } else {
          tunnelMissRef.current += 1;
          if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false);
        }
        const tsEn = data.tailscale?.settingsEnabled ?? data.tailscale?.enabled ?? false;
        setTsUrl(data.tailscale?.tunnelUrl || "");
        setTsEnabled(tsEn);
        if (tsClientReachableRef.current) {
          tsMissRef.current = 0;
          setTsReachable(true);
          if (!tsEverReachableRef.current) {
            tsEverReachableRef.current = true;
            setTsEverReachable(true);
          }
        } else {
          tsMissRef.current += 1;
          if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false);
        }
      }
    } catch (error) {
      console.log("Error loading settings:", error);
    } finally {
      setTunnelChecking(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Status poll: only while degraded (not yet reachable). Stop once healthy to avoid spam.
  useEffect(() => {
    const anyEnabled = tunnelEnabled || tsEnabled;
    if (!anyEnabled) return;
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    const allHealthy = tunnelHealthy && tsHealthy;
    const onVisible = () => {
      if (!document.hidden) syncTunnelStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (allHealthy) return () => document.removeEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => {
      if (!document.hidden) syncTunnelStatus();
    }, STATUS_POLL_FAST_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tunnelEnabled, tsEnabled, tunnelReachable, tsReachable, syncTunnelStatus]);

  // Browser-side periodic ping while degraded; pause when tab hidden.
  useEffect(() => {
    const probeBoth = async () => {
      if (document.hidden) return;
      if (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) {
        const ok = await clientPingAny(tunnelPublicUrl, tunnelUrl);
        tunnelClientReachableRef.current = ok;
        if (ok) {
          tunnelMissRef.current = 0;
          setTunnelReachable(true);
          if (!tunnelEverReachableRef.current) {
            tunnelEverReachableRef.current = true;
            setTunnelEverReachable(true);
          }
        } else {
          tunnelMissRef.current += 1;
          if (tunnelMissRef.current >= REACHABLE_MISS_THRESHOLD) setTunnelReachable(false);
        }
      } else {
        tunnelClientReachableRef.current = false;
      }
      if (tsEnabled && tsUrl) {
        const ok = await clientPingUrl(tsUrl);
        tsClientReachableRef.current = ok;
        if (ok) {
          tsMissRef.current = 0;
          setTsReachable(true);
          if (!tsEverReachableRef.current) {
            tsEverReachableRef.current = true;
            setTsEverReachable(true);
          }
        } else {
          tsMissRef.current += 1;
          if (tsMissRef.current >= REACHABLE_MISS_THRESHOLD) setTsReachable(false);
        }
      } else {
        tsClientReachableRef.current = false;
      }
    };
    const anyEnabled = (tunnelEnabled && (tunnelUrl || tunnelPublicUrl)) || (tsEnabled && tsUrl);
    if (!anyEnabled) return;
    probeBoth();
    const tunnelHealthy = !tunnelEnabled || tunnelReachable;
    const tsHealthy = !tsEnabled || tsReachable;
    if (tunnelHealthy && tsHealthy) return;
    const id = setInterval(probeBoth, CLIENT_PING_FAST_MS);
    return () => clearInterval(id);
  }, [tunnelEnabled, tunnelUrl, tunnelPublicUrl, tsEnabled, tsUrl, tunnelReachable, tsReachable]);

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

  // ─── Cloudflare Tunnel handlers ───
  // Ping tunnel health until reachable. Race multiple URLs (shortlink + direct) — 1 OK is enough.
  const pingTunnelHealth = async (...urls) => {
    setTunnelLoading(true);
    setTunnelProgress("Waiting for tunnel ready...");
    const targets = urls.filter(Boolean).map((u) => `${u}/api/health`);
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      const ok = await Promise.any(
        targets.map(async (h) => {
          const p = await fetch(h, { mode: "cors", cache: "no-store" });
          if (p.ok) return true;
          throw new Error("not ready");
        }),
      ).catch(() => false);
      if (ok) {
        setTunnelEnabled(true);
        setTunnelLoading(false);
        setTunnelProgress("");
        return true;
      }
      // Every ~10s, check if backend process still alive
      if ((Date.now() - start) % 10000 < TUNNEL_PING_INTERVAL_MS) {
        try {
          const statusRes = await fetch("/api/tunnel/status");
          if (statusRes.ok) {
            const status = await statusRes.json();
            if (!status.tunnel?.enabled) {
              setTunnelStatus({ type: "error", message: "Tunnel process stopped unexpectedly." });
              setTunnelLoading(false);
              setTunnelProgress("");
              return false;
            }
          }
        } catch {
          /* ignore */
        }
      }
    }
    setTunnelStatus({
      type: "error",
      message: "Tunnel created but not reachable. Please try again.",
    });
    setTunnelLoading(false);
    setTunnelProgress("");
    return false;
  };

  const handleEnableTunnel = async () => {
    setShowEnableTunnelModal(false);
    setTunnelLoading(true);
    setTunnelStatus(null);
    setTunnelProgress("Creating tunnel...");

    // Poll download progress while enable request is pending
    let polling = true;
    const pollProgress = async () => {
      while (polling) {
        try {
          const r = await fetch("/api/tunnel/status");
          if (r.ok) {
            const s = await r.json();
            if (s.download?.downloading) {
              setTunnelProgress(`Downloading cloudflared... ${s.download.progress}%`);
            } else if (polling) {
              setTunnelProgress("Creating tunnel...");
            }
          }
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };
    pollProgress();

    try {
      const res = await fetch("/api/tunnel/enable", { method: "POST" });
      polling = false;
      const data = await res.json();
      if (!res.ok) {
        setTunnelStatus({ type: "error", message: data.error || "Failed to enable tunnel" });
        return;
      }
      const url = data.tunnelUrl;
      if (!url) {
        setTunnelStatus({ type: "error", message: "No tunnel URL returned" });
        return;
      }
      setTunnelUrl(url);
      setTunnelPublicUrl(data.publicUrl || "");
      await pingTunnelHealth(data.publicUrl, url);
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      polling = false;
      setTunnelLoading(false);
      setTunnelProgress("");
    }
  };

  const handleDisableTunnel = async () => {
    setTunnelLoading(true);
    setTunnelStatus(null);
    try {
      const res = await fetch("/api/tunnel/disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTunnelEnabled(false);
        setTunnelUrl("");
        setTunnelPublicUrl("");
        setShowDisableTunnelModal(false);
        setTunnelStatus({ type: "success", message: "Tunnel disabled" });
      } else {
        setTunnelStatus({ type: "error", message: data.error || "Failed to disable tunnel" });
      }
    } catch (error) {
      setTunnelStatus({ type: "error", message: error.message });
    } finally {
      setTunnelLoading(false);
    }
  };

  // ─── Tailscale handlers ───
  const checkTailscaleInstalled = async () => {
    setTsInstalled(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-check");
      if (res.ok) {
        const data = await res.json();
        setTsInstalled(data.installed);
        return data;
      }
    } catch {
      /* ignore */
    }
    setTsInstalled(false);
    return { installed: false };
  };

  const handleInstallTailscale = async () => {
    setTsInstalling(true);
    setTsStatus(null);
    setTsInstallLog([]);
    try {
      const res = await fetch("/api/tunnel/tailscale-install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sudoPassword: tsSudoPassword }),
      });
      setTsSudoPassword("");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";
        for (const part of parts) {
          const lines = part.split("\n");
          let event = "progress";
          let data = null;
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7).trim();
            if (line.startsWith("data: ")) {
              try {
                data = JSON.parse(line.slice(6));
              } catch {
                /* skip */
              }
            }
          }
          if (!data) continue;
          if (event === "progress") {
            setTsInstallLog((prev) => [...prev.slice(-50), data.message]);
          } else if (event === "done") {
            setTsInstalled(true);
            setTsInstalling(false);
            setShowTsModal(false);
            handleConnectTailscale();
            return;
          } else if (event === "error") {
            setTsStatus({ type: "error", message: data.error || "Install failed" });
          }
        }
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsInstalling(false);
    }
  };

  // Ping Tailscale health until reachable
  const pingTsHealth = async (url) => {
    setTsProgress("Waiting for Tailscale ready...");
    const healthUrl = `${url}/api/health`;
    const start = Date.now();
    while (Date.now() - start < TUNNEL_PING_MAX_MS) {
      await new Promise((r) => setTimeout(r, TUNNEL_PING_INTERVAL_MS));
      try {
        const ping = await fetch(healthUrl, { mode: "no-cors", cache: "no-store" });
        if (ping.ok || ping.type === "opaque") return true;
      } catch {
        /* not ready yet */
      }
    }
    return false;
  };

  // Show inline login button instead of auto-opening popup (browsers block popups
  // opened after async work because the user gesture is lost).
  const requestUserAuth = (url, label) => {
    setTsAuthUrl(url);
    setTsAuthLabel(label);
  };

  const clearUserAuth = () => {
    setTsAuthUrl("");
    setTsAuthLabel("");
  };

  const pollFunnelEnable = async (enableUrl) => {
    requestUserAuth(enableUrl, "Open Funnel Settings");
    setTsProgress('Click "Open Funnel Settings" to enable Funnel...');
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
        const data = await res.json();
        if (res.ok && data.success) {
          clearUserAuth();
          setTsUrl(data.tunnelUrl || "");
          const ok3 = await pingTsHealth(data.tunnelUrl);
          setTsEnabled(true);
          setTsStatus(
            ok3 ? null : { type: "warning", message: "Connected but not reachable yet." },
          );
          return;
        }
        if (data.funnelNotEnabled) continue;
        if (data.error) {
          clearUserAuth();
          setTsStatus({ type: "error", message: data.error });
          return;
        }
      } catch {
        /* retry */
      }
    }
    clearUserAuth();
    setTsStatus({ type: "error", message: "Timed out waiting for Funnel to be enabled." });
  };

  const handleConnectTailscale = async () => {
    setShowTsModal(false);
    setTsConnecting(true);
    setTsLoading(true);
    setTsStatus(null);
    setTsProgress("Connecting...");
    clearUserAuth();
    try {
      const res = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
      const data = await res.json();

      if (res.ok && data.success) {
        setTsUrl(data.tunnelUrl || "");
        const reachable = await pingTsHealth(data.tunnelUrl);
        setTsEnabled(true);
        setTsStatus(
          reachable ? null : { type: "warning", message: "Connected but not reachable yet." },
        );
        return;
      }

      if (data.needsLogin && data.authUrl) {
        requestUserAuth(data.authUrl, "Open Login Page");
        setTsProgress('Login required — click "Open Login Page" to continue');
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const r2 = await fetch("/api/tunnel/tailscale-check");
            if (r2.ok) {
              const check = await r2.json();
              if (check.loggedIn) {
                clearUserAuth();
                setTsProgress("Starting funnel...");
                const res2 = await fetch("/api/tunnel/tailscale-enable", { method: "POST" });
                const data2 = await res2.json();
                if (res2.ok && data2.success) {
                  setTsUrl(data2.tunnelUrl || "");
                  const ok2 = await pingTsHealth(data2.tunnelUrl);
                  setTsEnabled(true);
                  setTsStatus(
                    ok2 ? null : { type: "warning", message: "Connected but not reachable yet." },
                  );
                } else if (data2.funnelNotEnabled && data2.enableUrl) {
                  await pollFunnelEnable(data2.enableUrl);
                } else {
                  setTsStatus({ type: "error", message: data2.error || "Failed to start funnel" });
                }
                return;
              }
            }
          } catch {
            /* retry */
          }
        }
        clearUserAuth();
        setTsStatus({ type: "error", message: "Login timed out. Please try again." });
        return;
      }

      if (data.funnelNotEnabled && data.enableUrl) {
        await pollFunnelEnable(data.enableUrl);
        return;
      }

      setTsStatus({ type: "error", message: data.error || "Failed to connect" });
    } catch (error) {
      setTsStatus({ type: "error", message: error.message });
    } finally {
      setTsLoading(false);
      setTsConnecting(false);
      setTsProgress("");
      clearUserAuth();
    }
  };

  const handleDisableTailscale = async () => {
    setTsLoading(true);
    setTsStatus(null);
    try {
      const res = await fetch("/api/tunnel/tailscale-disable", { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setTsEnabled(false);
        setTsUrl("");
        setShowDisableTsModal(false);
        setTsStatus({ type: "success", message: "Tailscale disabled" });
      } else {
        setTsStatus({ type: "error", message: data.error || "Failed to disable Tailscale" });
      }
    } catch (e) {
      setTsStatus({ type: "error", message: e.message });
    } finally {
      setTsLoading(false);
    }
  };

  const handleOpenTsModal = async () => {
    setTsStatus(null);
    setTsInstallLog([]);
    const data = await checkTailscaleInstalled();
    if (data?.installed && data?.hasCachedPassword) {
      handleConnectTailscale();
    } else {
      setShowTsModal(true);
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
    tunnelChecking,
    setTunnelChecking,
    tunnelEnabled,
    tunnelReachable,
    tunnelEverReachable,
    tunnelUrl,
    tunnelPublicUrl,
    tunnelLoading,
    setTunnelLoading,
    tunnelProgress,
    setTunnelProgress,
    tunnelStatus,
    setTunnelStatus,
    showEnableTunnelModal,
    setShowEnableTunnelModal,
    showDisableTunnelModal,
    setShowDisableTunnelModal,
    syncTunnelStatus,
    handleEnableTunnel,
    handleDisableTunnel,
    // tailscale
    tsEnabled,
    tsReachable,
    tsEverReachable,
    tsUrl,
    tsLoading,
    setTsLoading,
    tsProgress,
    setTsProgress,
    tsStatus,
    setTsStatus,
    tsAuthUrl,
    tsAuthLabel,
    tsInstalled,
    tsInstalling,
    tsInstallLog,
    tsSudoPassword,
    setTsSudoPassword,
    tsConnecting,
    setTsConnecting,
    showTsModal,
    setShowTsModal,
    showDisableTsModal,
    setShowDisableTsModal,
    tsLogRef,
    checkTailscaleInstalled,
    handleInstallTailscale,
    handleConnectTailscale,
    handleDisableTailscale,
    handleOpenTsModal,
    pollFunnelEnable,
    requestUserAuth,
    clearUserAuth,
    updateReachable,
  };
}
