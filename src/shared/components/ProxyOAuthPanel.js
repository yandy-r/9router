"use client";

import PropTypes from "prop-types";
import Button from "./Button";
import Input from "./Input";

// Providers offering a paste-token fallback (import-token flow).
// UX warns if the IDE (which issues the token) is not installed.
export const PASTE_TOKEN_PROVIDERS = {
  trae: {
    label: "Cloud-IDE-JWT",
    instructions:
      "Sign in at trae.ai (or solo.trae.ai), open DevTools → Network, copy the Cloud-IDE-JWT token from any request's Authorization header (~14-day lifetime).",
    placeholder: "Paste Cloud-IDE-JWT here...",
    ideName: "Trae",
    ideOptional: true, // token can be grabbed from DevTools without the IDE
  },
  windsurf: {
    label: "Windsurf API key",
    instructions:
      "In the Windsurf/VS Code IDE, run the \"Windsurf: Provide Auth Token\" command, then copy the displayed sk-ws-... key.",
    placeholder: "Paste sk-ws-... key here...",
    ideName: "Windsurf",
    ideOptional: false,
  },
};

function modeTabClass(active) {
  return `flex-1 rounded-lg border px-3 py-2 text-sm transition-colors ${
    active ? "border-primary bg-primary/10 text-primary" : "border-border text-text-muted hover:text-primary"
  }`;
}

/**
 * Trae/Windsurf/Zed dynamic-port proxy flow. Browser mode waits for the local
 * callback proxy, but always offers a manual callback-URL paste: the redirect
 * targets 127.0.0.1 on the 9router host, which the browser cannot reach when
 * 9router runs in Docker or on another machine.
 */
export default function ProxyOAuthPanel({
  provider,
  step,
  authMode,
  authUrl,
  callbackUrl,
  onCallbackUrlChange,
  pasteToken,
  onPasteTokenChange,
  ideStatus,
  onSelectBrowser,
  onSelectPasteToken,
  onSubmit,
  onCancel,
  copied,
  onCopy,
}) {
  const pasteConfig = PASTE_TOKEN_PROVIDERS[provider];

  return (
    <>
      {pasteConfig && (
        <div className="flex gap-2">
          <button type="button" onClick={onSelectBrowser} className={modeTabClass(authMode === "browser")}>
            🌐 Sign in with browser
          </button>
          <button type="button" onClick={onSelectPasteToken} className={modeTabClass(authMode === "paste-token")}>
            🔑 Paste token
          </button>
        </div>
      )}

      {authMode === "browser" && (step === "waiting" || step === "input") && (
        <>
          {step === "waiting" ? (
            <div className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg bg-sidebar/50">
              <span className="material-symbols-outlined text-base text-primary animate-spin">progress_activity</span>
              <span className="text-sm">Waiting for browser authorization…</span>
            </div>
          ) : (
            <p className="text-sm text-text-muted">Popup was blocked. Open the sign-in URL below in your browser.</p>
          )}

          <div className="flex items-center gap-3 my-1">
            <div className="flex-1 h-px bg-border" />
            <span className="text-xs text-text-muted uppercase tracking-wider">Or paste callback URL manually</span>
            <div className="flex-1 h-px bg-border" />
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-2">Step 1: Open this sign-in URL in your browser</p>
              <div className="flex gap-2">
                <Input value={authUrl || ""} readOnly className="flex-1 font-mono text-xs" />
                <Button
                  variant="secondary"
                  icon={copied === "proxy_auth_url" ? "check" : "content_copy"}
                  onClick={() => onCopy(authUrl, "proxy_auth_url")}
                  disabled={!authUrl}
                >
                  Copy
                </Button>
              </div>
            </div>
            <div>
              <p className="text-sm font-medium mb-2">Step 2: Paste the callback URL here</p>
              <p className="text-xs text-text-muted mb-2">
                After signing in, the browser is sent to a http://127.0.0.1:… address. If that page does not load
                (for example when 9router runs in Docker or on another machine), copy the full URL from the address
                bar and paste it here.
              </p>
              <Input
                value={callbackUrl}
                onChange={(e) => onCallbackUrlChange(e.target.value)}
                placeholder="http://127.0.0.1:.../?user_id=...&access_token=..."
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={onSubmit} fullWidth disabled={!callbackUrl.trim()}>Connect</Button>
            <Button onClick={onCancel} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </>
      )}

      {authMode === "paste-token" && pasteConfig && (
        <div className="space-y-3">
          {ideStatus && !ideStatus.installed && (
            <div className={`px-3 py-2 rounded-lg text-sm ${pasteConfig.ideOptional ? "bg-blue-500/10 text-blue-700 dark:text-blue-300" : "bg-yellow-500/10 text-yellow-700 dark:text-yellow-300"}`}>
              {pasteConfig.ideName} IDE not detected.
              {pasteConfig.ideOptional
                ? " You can still grab the token from DevTools."
                : ` Install ${pasteConfig.ideName} IDE to get the token, or use "Sign in with browser".`}
            </div>
          )}
          <p className="text-sm text-text-muted">{pasteConfig.instructions}</p>
          <Input
            value={pasteToken}
            onChange={(e) => onPasteTokenChange(e.target.value)}
            placeholder={pasteConfig.placeholder}
            className="font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button onClick={onSubmit} fullWidth disabled={!pasteToken.trim()}>Connect</Button>
            <Button onClick={onCancel} variant="ghost" fullWidth>Cancel</Button>
          </div>
        </div>
      )}
    </>
  );
}

ProxyOAuthPanel.propTypes = {
  provider: PropTypes.string.isRequired,
  step: PropTypes.oneOf(["waiting", "input", "success", "error"]).isRequired,
  authMode: PropTypes.oneOf(["browser", "paste-token"]).isRequired,
  authUrl: PropTypes.string,
  callbackUrl: PropTypes.string.isRequired,
  onCallbackUrlChange: PropTypes.func.isRequired,
  pasteToken: PropTypes.string.isRequired,
  onPasteTokenChange: PropTypes.func.isRequired,
  ideStatus: PropTypes.shape({ installed: PropTypes.bool, path: PropTypes.string }),
  onSelectBrowser: PropTypes.func.isRequired,
  onSelectPasteToken: PropTypes.func.isRequired,
  onSubmit: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
  copied: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
};
