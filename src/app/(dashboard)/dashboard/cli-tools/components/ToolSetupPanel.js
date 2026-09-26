"use client";

import PropTypes from "prop-types";
import { CardSkeleton } from "@/shared/components";
import { CLI_TOOLS } from "@/shared/constants/cliTools";
import ClaudeToolCard from "./ClaudeToolCard";
import CodexToolCard from "./CodexToolCard";
import OpenCodeToolCard from "./OpenCodeToolCard";
import CopilotToolCard from "./CopilotToolCard";
import CoworkToolCard from "./CoworkToolCard";
import ClineToolCard from "./ClineToolCard";
import KiloToolCard from "./KiloToolCard";
import DroidToolCard from "./DroidToolCard";
import HermesToolCard from "./HermesToolCard";
import OpenClawToolCard from "./OpenClawToolCard";
import DeepSeekTuiToolCard from "./DeepSeekTuiToolCard";
import JcodeToolCard from "./JcodeToolCard";
import GrokBuildToolCard from "./GrokBuildToolCard";
import DefaultToolCard from "./DefaultToolCard";

const TOOL_CARDS = {
  claude: ClaudeToolCard,
  codex: CodexToolCard,
  opencode: OpenCodeToolCard,
  copilot: CopilotToolCard,
  cowork: CoworkToolCard,
  cline: ClineToolCard,
  kilo: KiloToolCard,
  droid: DroidToolCard,
  hermes: HermesToolCard,
  openclaw: OpenClawToolCard,
  "deepseek-tui": DeepSeekTuiToolCard,
  jcode: JcodeToolCard,
  "grok-build": GrokBuildToolCard,
};

/** One setup surface for inline aside and deep-link detail route. */
export default function ToolSetupPanel({ toolId, data, onStatusUpdate }) {
  const tool = CLI_TOOLS[toolId];
  if (!tool) return null;
  if (data.loading) return <CardSkeleton />;
  const CardComponent = TOOL_CARDS[toolId] || DefaultToolCard;
  return (
    <CardComponent
      key={toolId}
      toolId={toolId}
      tool={tool}
      baseUrl={data.defaultBaseUrl}
      apiKeys={data.apiKeys}
      activeProviders={data.activeProviders}
      hasActiveProviders={data.hasActiveProviders}
      cloudEnabled={data.cloudEnabled}
      cloudUrl={data.cloudUrl}
      tunnelEnabled={data.tunnelEnabled}
      tunnelPublicUrl={data.tunnelPublicUrl}
      tailscaleEnabled={data.tailscaleEnabled}
      tailscaleUrl={data.tailscaleUrl}
      modelAliases={data.modelAliases}
      onStatusUpdate={onStatusUpdate}
    />
  );
}

ToolSetupPanel.propTypes = {
  toolId: PropTypes.string.isRequired,
  data: PropTypes.shape({
    loading: PropTypes.bool,
    defaultBaseUrl: PropTypes.string,
    apiKeys: PropTypes.array,
    activeProviders: PropTypes.array,
    hasActiveProviders: PropTypes.bool,
    cloudEnabled: PropTypes.bool,
    cloudUrl: PropTypes.string,
    tunnelEnabled: PropTypes.bool,
    tunnelPublicUrl: PropTypes.string,
    tailscaleEnabled: PropTypes.bool,
    tailscaleUrl: PropTypes.string,
    modelAliases: PropTypes.object,
  }).isRequired,
  onStatusUpdate: PropTypes.func,
};
