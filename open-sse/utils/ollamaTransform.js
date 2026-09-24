// Transform an OpenAI-format handleChat response into the Ollama /api/chat format.
import { ROLE, OPENAI_FINISH } from "../translator/schema/index.js";

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson",
  "Access-Control-Allow-Origin": "*",
};
const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function parseArgs(args) {
  if (args && typeof args === "object") return args;
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

function toOllamaToolCalls(toolCalls) {
  return toolCalls.map((tc) => ({
    function: { name: tc.function?.name || "", arguments: parseArgs(tc.function?.arguments) },
  }));
}

// Ollama's done_reason only knows stop/length (+ tool_calls on the message carrying calls).
function toOllamaDoneReason(finishReason) {
  if (finishReason === OPENAI_FINISH.LENGTH || finishReason === OPENAI_FINISH.TOOL_CALLS) {
    return finishReason;
  }
  return OPENAI_FINISH.STOP;
}

function assistantMessage(content, thinking, toolCalls) {
  const message = { role: ROLE.ASSISTANT, content: content || "" };
  if (thinking) message.thinking = thinking;
  if (toolCalls?.length) message.tool_calls = toOllamaToolCalls(toolCalls);
  return message;
}

function ollamaMessage(model, message, done, finishReason) {
  const out = { model, created_at: new Date().toISOString(), message, done };
  if (done) out.done_reason = toOllamaDoneReason(finishReason);
  return out;
}

function errorMessage(err, fallback) {
  return typeof err === "string" ? err : err?.message || fallback;
}

function ollamaErrorResponse(status, message, retryAfter) {
  const headers = { ...JSON_HEADERS };
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

// Non-2xx: keep the status, reshape the body into Ollama's `{ error: string }`.
async function toOllamaError(response) {
  const text = await response.text().catch(() => "");
  let message = text || response.statusText || `HTTP ${response.status}`;
  try {
    message = errorMessage(JSON.parse(text).error, message);
  } catch {}
  return ollamaErrorResponse(response.status, message, response.headers.get("Retry-After"));
}

// stream:false: handleChat returns one OpenAI chat.completion JSON body.
async function toOllamaJson(response, model) {
  const body = await response.json().catch(() => null);
  if (body?.error) return ollamaErrorResponse(502, errorMessage(body.error, "Upstream error"));
  if (!Array.isArray(body?.choices)) {
    return ollamaErrorResponse(502, "Invalid upstream response");
  }
  const choice = body.choices[0] || {};
  const msg = choice.message || {};
  const message = assistantMessage(msg.content, msg.reasoning_content, msg.tool_calls);
  return new Response(JSON.stringify(ollamaMessage(model, message, true, choice.finish_reason)), {
    status: response.status,
    headers: JSON_HEADERS,
  });
}

function toOllamaStream(response, model) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let pendingToolCalls = {};
  let done = false;

  const emit = (controller, obj) => controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));

  // Exactly one done:true line; carries any tool calls still pending.
  const emitDone = (controller, finishReason) => {
    if (done) return;
    done = true;
    const calls = Object.values(pendingToolCalls);
    pendingToolCalls = {};
    emit(controller, ollamaMessage(model, assistantMessage("", "", calls), true, finishReason));
  };

  const handleLine = (line, controller) => {
    if (done || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return emitDone(controller);

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    // Mid-stream failure frame (see writeStreamError): surface it, then end the stream.
    if (parsed.error) {
      emit(controller, { error: errorMessage(parsed.error, "Upstream error") });
      done = true;
      return;
    }
    const choice = parsed.choices?.[0] || {};
    const delta = choice.delta || {};

    for (const tc of delta.tool_calls || []) {
      pendingToolCalls[tc.index] ||= { function: { name: "", arguments: "" } };
      const acc = pendingToolCalls[tc.index];
      if (tc.function?.name) acc.function.name += tc.function.name;
      if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
    }

    if (delta.content || delta.reasoning_content) {
      const message = assistantMessage(delta.content, delta.reasoning_content);
      emit(controller, ollamaMessage(model, message, false));
    }

    if (choice.finish_reason) emitDone(controller, choice.finish_reason);
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      for (const line of buffer.split("\n")) handleLine(line, controller);
      emitDone(controller);
    },
  });

  return new Response(response.body.pipeThrough(transform), { headers: NDJSON_HEADERS });
}

export function transformToOllama(response, model) {
  if (!response.ok) return toOllamaError(response);
  if (!response.body) {
    return new Response("", { status: response.status, headers: NDJSON_HEADERS });
  }
  const contentType = response.headers.get("Content-Type") || "";
  if (!contentType.includes("text/event-stream")) return toOllamaJson(response, model);
  return toOllamaStream(response, model);
}
