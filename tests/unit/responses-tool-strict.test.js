// YAN-16: Responses treats an absent function-tool `strict` as strict mode,
// which forces every optional field (OpenCode subagent sessionID:"ses_invalid").
import { describe, expect, it } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { OpenCodeGoExecutor } from "../../open-sse/executors/opencode-go.js";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";

const PARAMS = { type: "object", properties: { sessionID: { type: "string" } } };
const INPUT = [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }];

function chatTool(strict) {
  const fn = { name: "subagent", description: "d", parameters: PARAMS };
  if (strict !== undefined) fn.strict = strict;
  return { type: "function", function: fn };
}

function flatTool(strict) {
  const tool = { type: "function", name: "subagent", description: "d", parameters: PARAMS };
  if (strict !== undefined) tool.strict = strict;
  return tool;
}

describe("Chat → Responses tool strict (YAN-16)", () => {
  it.each([
    ["absent → false", undefined, false],
    ["false preserved", false, false],
    ["true preserved", true, true],
  ])("%s", (_label, strict, expected) => {
    const out = openaiToOpenAIResponsesRequest("gpt-5.5", {
      messages: [{ role: "user", content: "hi" }],
      tools: [chatTool(strict)],
    }, true, {});
    expect(out.tools[0].strict).toBe(expected);
  });
});

const EXECUTORS = [
  ["codex", () => new CodexExecutor(), "gpt-5.5"],
  ["opencode", () => new OpenCodeExecutor(), "muse-spark-1.2-contributor-free"],
  ["opencode-go", () => new OpenCodeGoExecutor(), "muse-spark-1.3-contributor"],
  ["grok-cli", () => new GrokCliExecutor(), "grok-4.5"],
];

describe.each(EXECUTORS)("%s executor keeps function tool strict (YAN-16)", (_name, make, model) => {
  function normalize(tool) {
    const body = { model, input: structuredClone(INPUT), tools: [tool], stream: true };
    const out = make().transformRequest(model, body, true, { connectionId: "yan-16" });
    return out.tools.find((t) => t.name === "subagent");
  }

  it.each([
    ["flat false", flatTool(false), false],
    ["nested false", chatTool(false), false],
    ["flat true", flatTool(true), true],
    ["nested true", chatTool(true), true],
    ["nested absent → false", chatTool(undefined), false],
    ["flat wins over nested", { ...flatTool(false), function: { strict: true } }, false],
  ])("%s", (_label, tool, expected) => {
    expect(normalize(tool).strict).toBe(expected);
  });

  it("leaves strict absent on a flat tool that omitted it", () => {
    expect("strict" in normalize(flatTool(undefined))).toBe(false);
  });
});
