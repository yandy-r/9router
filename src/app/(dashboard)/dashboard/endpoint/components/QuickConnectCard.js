"use client";

import Link from "next/link";
import PropTypes from "prop-types";
import { useState } from "react";
import { Card, Button, Select, Tabs } from "@/shared/components";
import { buildQuickConnectSnippet, maskKey } from "../endpointLogic";

const LANGUAGES = [
  { value: "shell", label: "Shell" },
  { value: "curl", label: "cURL" },
  { value: "python", label: "Python" },
];

/**
 * Quick connect card: key picker + Shell/cURL/Python snippet with copy.
 * When the selected key matches the just-created `revealed` key, the snippet
 * embeds the real plain text; otherwise it embeds the masked form so the
 * snippet is copy-paste illustrative without leaking keys on screen.
 *
 * @param {object} props
 * @param {string} props.baseUrl Endpoint root (e.g. http://localhost:20128/v1).
 * @param {string|null} props.selectedKeyId
 * @param {Array} props.keys Key rows {id,name,key}.
 * @param {{ id: string, plain: string }|null} props.revealed Just-created key plain text.
 * @param {(id: string) => void} props.onSelectKey
 * @param {(text: string, id: string) => void} props.onCopy
 * @param {string|null} props.copiedId
 */
export default function QuickConnectCard({
  baseUrl,
  selectedKeyId,
  keys,
  revealed,
  onSelectKey,
  onCopy,
  copiedId,
}) {
  const [language, setLanguage] = useState("shell");
  const selected = keys.find((key) => key.id === selectedKeyId) ?? null;
  const snippetKey =
    revealed && revealed.id === selectedKeyId
      ? revealed.plain
      : selected
        ? maskKey(selected.key)
        : "";
  const snippet = buildQuickConnectSnippet(language, baseUrl, snippetKey);

  return (
    <Card title="Quick connect" icon="bolt">
      <div className="flex flex-col gap-4">
        <Select
          label="API key"
          value={selectedKeyId ?? ""}
          onChange={(event) => onSelectKey(event.target.value)}
          options={keys.map((key) => ({ value: key.id, label: key.name }))}
          placeholder={keys.length === 0 ? "No keys yet" : "Select a key"}
          disabled={keys.length === 0}
        />

        <Tabs
          tabs={LANGUAGES}
          value={language}
          onChange={setLanguage}
          aria-label="Quick connect language"
        />

        <div className="overflow-hidden rounded-xl border border-line bg-raised">
          <pre
            dir="ltr"
            className="max-h-64 overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-[13px] leading-relaxed text-text"
          >
            <code>{snippet}</code>
          </pre>
          <div className="flex justify-end border-t border-line px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              icon={copiedId === `quick-${language}` ? "check" : "content_copy"}
              onClick={() => onCopy(snippet, `quick-${language}`)}
            >
              {copiedId === `quick-${language}` ? "Copied!" : "Copy snippet"}
            </Button>
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <Link
            href="/dashboard/cli-tools"
            className="text-sm font-medium text-coral hover:underline"
          >
            Using a coding CLI? Set it up in one click &rarr;
          </Link>
        </div>
      </div>
    </Card>
  );
}

QuickConnectCard.propTypes = {
  baseUrl: PropTypes.string.isRequired,
  selectedKeyId: PropTypes.string,
  keys: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string.isRequired,
      name: PropTypes.string.isRequired,
      key: PropTypes.string.isRequired,
    }),
  ).isRequired,
  revealed: PropTypes.shape({
    id: PropTypes.string.isRequired,
    plain: PropTypes.string.isRequired,
  }),
  onSelectKey: PropTypes.func.isRequired,
  onCopy: PropTypes.func.isRequired,
  copiedId: PropTypes.string,
};
