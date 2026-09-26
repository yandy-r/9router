"use client";

import PropTypes from "prop-types";
import {
  Card,
  Button,
  IconButton,
  SettingRow,
  Toggle,
  EmptyState,
  StatusPill,
} from "@/shared/components";
import { maskKey, formatLastUsed, isNewKey, formatNumber } from "../endpointLogic";

/**
 * One-time reveal banner shown after a key is created. The plain key is never
 * retrievable again, so this is the only copy affordance.
 */
function CreatedBanner({ banner, copiedId, onCopy, onDismiss }) {
  return (
    <div role="alert" className="mb-4 flex gap-3 rounded-xl border border-lime/40 bg-lime-bg p-4">
      <span
        className="material-symbols-outlined shrink-0 text-[20px] text-lime-ink"
        aria-hidden="true"
      >
        vpn_key
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">
          {banner.keyName} is ready. Copy it now, it won&apos;t be shown again.
        </p>
        <code className="mt-1 block truncate font-mono text-sm text-text" dir="ltr">
          {banner.plainKey}
        </code>
        <div className="mt-2">
          <Button
            variant="primary"
            size="sm"
            icon={copiedId === "created-banner" ? "check" : "content_copy"}
            onClick={() => onCopy(banner.plainKey, "created-banner")}
          >
            {copiedId === "created-banner" ? "Copied!" : "Copy key"}
          </Button>
        </div>
      </div>
      <IconButton icon="close" aria-label="Dismiss" onClick={onDismiss} className="self-start" />
    </div>
  );
}

CreatedBanner.propTypes = {
  banner: PropTypes.shape({
    keyName: PropTypes.string.isRequired,
    plainKey: PropTypes.string.isRequired,
  }).isRequired,
  copiedId: PropTypes.string,
  onCopy: PropTypes.func.isRequired,
  onDismiss: PropTypes.func.isRequired,
};

function KeyStatusTags({ apiKey }) {
  return (
    <>
      {apiKey.isActive === false && (
        <StatusPill variant="warn" size="sm">
          Paused
        </StatusPill>
      )}
      {isNewKey(apiKey.createdAt) && apiKey.isActive !== false && (
        <StatusPill variant="live" size="sm">
          New
        </StatusPill>
      )}
    </>
  );
}

KeyStatusTags.propTypes = {
  apiKey: PropTypes.shape({
    isActive: PropTypes.bool,
    createdAt: PropTypes.string,
  }).isRequired,
};

/**
 * API keys management card: require-key gate, one-time reveal banner, key
 * table on desktop and stacked cards on mobile. The create/delete modals live
 * in the parent — this card only fires callbacks.
 *
 * @param {object} props
 * @param {Array} props.keys Key rows {id,name,key,isActive,createdAt,lastUsed,requestsToday}.
 * @param {boolean} props.requireApiKey Toggle state for the 401 gate.
 * @param {(checked: boolean) => void} props.onToggleRequireApiKey
 * @param {() => void} props.onCreateKey Opens the create modal in the parent.
 * @param {{keyName: string, plainKey: string}|null} props.createdBanner Just-created key (one-time).
 * @param {() => void} props.onDismissBanner
 * @param {(text: string, id: string) => void} props.onCopy
 * @param {string|null} props.copiedId
 * @param {Set<string>} props.visibleIds Unmasked key ids.
 * @param {(id: string) => void} props.onToggleVisibility
 * @param {string|null} props.togglingId Row id mid-toggle.
 * @param {(id: string, checked: boolean) => void} props.onToggleKey
 * @param {string|null} props.deletingId Row id mid-delete.
 * @param {(id: string) => void} props.onDeleteKey Opens the delete confirm in the parent.
 * @param {boolean} props.loading Initial list load.
 */
export default function ApiKeysCard({
  keys,
  requireApiKey,
  onToggleRequireApiKey,
  onCreateKey,
  createdBanner,
  onDismissBanner,
  onCopy,
  copiedId,
  visibleIds,
  onToggleVisibility,
  togglingId,
  onToggleKey,
  deletingId,
  onDeleteKey,
  loading,
}) {
  const showValue = (apiKey) => (visibleIds.has(apiKey.id) ? apiKey.key : maskKey(apiKey.key));

  return (
    <Card
      id="require-api-key"
      title="API keys"
      icon="vpn_key"
      action={
        <>
          <StatusPill variant="neutral" size="sm">
            {keys.length}
          </StatusPill>
          <Button variant="primary" size="sm" icon="add" onClick={onCreateKey}>
            Create key
          </Button>
        </>
      }
    >
      <SettingRow
        label="Require API key"
        description="Requests without a valid key get a 401. The tunnel needs this on."
        settingKey="requireApiKey"
        control={
          <Toggle
            checked={requireApiKey}
            onChange={onToggleRequireApiKey}
            aria-label="Require API key"
          />
        }
      />

      {createdBanner && (
        <CreatedBanner
          banner={createdBanner}
          copiedId={copiedId}
          onCopy={onCopy}
          onDismiss={onDismissBanner}
        />
      )}

      {loading ? (
        <p className="py-6 text-center text-sm text-muted" aria-live="polite">
          Loading keys...
        </p>
      ) : keys.length === 0 && !createdBanner ? (
        <EmptyState
          icon="vpn_key"
          title="No API keys yet"
          body="Create your first API key to call the endpoint."
          action={
            <Button variant="primary" icon="add" onClick={onCreateKey}>
              Create key
            </Button>
          }
        />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-start text-xs text-muted">
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Name
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Key
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Created
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    Last used
                  </th>
                  <th scope="col" className="py-2 pe-3 text-end font-semibold">
                    Today
                  </th>
                  <th scope="col" className="py-2 pe-3 text-start font-semibold">
                    On
                  </th>
                  <th scope="col" className="py-2 text-end">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {keys.map((apiKey) => (
                  <tr key={apiKey.id} className="border-b border-line last:border-b-0">
                    <td className="py-3 pe-3">
                      <span className="flex flex-wrap items-center gap-1.5 font-medium text-text">
                        {apiKey.name}
                        <KeyStatusTags apiKey={apiKey} />
                      </span>
                    </td>
                    <td className="py-3 pe-3">
                      <code className="font-mono text-[13px] text-muted" dir="ltr">
                        {showValue(apiKey)}
                      </code>
                    </td>
                    <td className="py-3 pe-3 text-muted">
                      {apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="py-3 pe-3 text-muted">{formatLastUsed(apiKey.lastUsed)}</td>
                    <td className="py-3 pe-3 text-end font-mono text-muted">
                      {formatNumber(apiKey.requestsToday)}
                    </td>
                    <td className="py-3 pe-3">
                      <Toggle
                        size="sm"
                        checked={apiKey.isActive !== false}
                        disabled={togglingId === apiKey.id}
                        onChange={(checked) => onToggleKey(apiKey.id, checked)}
                        aria-label={`Enable key ${apiKey.name}`}
                      />
                    </td>
                    <td className="py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconButton
                          icon={visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"}
                          aria-label={visibleIds.has(apiKey.id) ? "Hide key" : "Show key"}
                          onClick={() => onToggleVisibility(apiKey.id)}
                        />
                        <IconButton
                          icon={copiedId === apiKey.id ? "check" : "content_copy"}
                          aria-label={`Copy key ${apiKey.name}`}
                          onClick={() => onCopy(apiKey.key, apiKey.id)}
                        />
                        <IconButton
                          icon="delete"
                          aria-label={`Delete key ${apiKey.name}`}
                          loading={deletingId === apiKey.id}
                          onClick={() => onDeleteKey(apiKey.id)}
                          className="hover:text-err"
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 md:hidden">
            {keys.map((apiKey) => (
              <div
                key={apiKey.id}
                className="flex flex-col gap-2 rounded-xl border border-line bg-raised p-3"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-text">{apiKey.name}</span>
                  <KeyStatusTags apiKey={apiKey} />
                </div>
                <div className="flex items-center gap-1">
                  <code
                    className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted"
                    dir="ltr"
                  >
                    {showValue(apiKey)}
                  </code>
                  <IconButton
                    icon={visibleIds.has(apiKey.id) ? "visibility_off" : "visibility"}
                    aria-label={visibleIds.has(apiKey.id) ? "Hide key" : "Show key"}
                    onClick={() => onToggleVisibility(apiKey.id)}
                  />
                  <IconButton
                    icon={copiedId === apiKey.id ? "check" : "content_copy"}
                    aria-label={`Copy key ${apiKey.name}`}
                    onClick={() => onCopy(apiKey.key, apiKey.id)}
                  />
                </div>
                <p className="text-xs text-muted">
                  Created {apiKey.createdAt ? new Date(apiKey.createdAt).toLocaleDateString() : "—"}{" "}
                  · {formatLastUsed(apiKey.lastUsed)} · {formatNumber(apiKey.requestsToday)} today
                </p>
                <div className="flex items-center justify-between">
                  <Toggle
                    size="sm"
                    checked={apiKey.isActive !== false}
                    disabled={togglingId === apiKey.id}
                    onChange={(checked) => onToggleKey(apiKey.id, checked)}
                    aria-label={`Enable key ${apiKey.name}`}
                  />
                  <IconButton
                    icon="delete"
                    aria-label={`Delete key ${apiKey.name}`}
                    loading={deletingId === apiKey.id}
                    onClick={() => onDeleteKey(apiKey.id)}
                    className="hover:text-err"
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

ApiKeysCard.propTypes = {
  keys: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      key: PropTypes.string.isRequired,
      isActive: PropTypes.bool,
      createdAt: PropTypes.string,
      lastUsed: PropTypes.string,
      requestsToday: PropTypes.number,
    }),
  ).isRequired,
  requireApiKey: PropTypes.bool.isRequired,
  onToggleRequireApiKey: PropTypes.func.isRequired,
  onCreateKey: PropTypes.func.isRequired,
  createdBanner: PropTypes.shape({
    keyName: PropTypes.string.isRequired,
    plainKey: PropTypes.string.isRequired,
  }),
  onDismissBanner: PropTypes.func.isRequired,
  onCopy: PropTypes.func.isRequired,
  copiedId: PropTypes.string,
  visibleIds: PropTypes.instanceOf(Set).isRequired,
  onToggleVisibility: PropTypes.func.isRequired,
  togglingId: PropTypes.string,
  onToggleKey: PropTypes.func.isRequired,
  deletingId: PropTypes.string,
  onDeleteKey: PropTypes.func.isRequired,
  loading: PropTypes.bool.isRequired,
};
