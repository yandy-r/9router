// Transform an OpenAI-format handleChat response into the Ollama /api/chat format.
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

function ollamaMessage(model, message, done, doneReason) {
  const out = { model, created_at: new Date().toISOString(), message, done };
  if (done) out.done_reason = doneReason || "stop";
  return out;
}

// Non-2xx: keep the status, reshape the body into Ollama's `{ error: string }`.
async function toOllamaError(response) {
  const text = await response.text().catch(() => "");
  let message = text || response.statusText || `HTTP ${response.status}`;
  try {
    const err = JSON.parse(text).error;
    message = typeof err === "string" ? err : err?.message || message;
  } catch {}
  const headers = { ...JSON_HEADERS };
  const retryAfter = response.headers.get("Retry-After");
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(JSON.stringify({ error: message }), { status: response.status, headers });
}

// stream:false: handleChat returns one OpenAI chat.completion JSON body.
async function toOllamaJson(response, model) {
  const body = await response.json();
  const choice = body.choices?.[0] || {};
  const msg = choice.message || {};
  const message = { role: "assistant", content: msg.content || "" };
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    message.tool_calls = toOllamaToolCalls(msg.tool_calls);
  }
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

  const emitDone = (controller, doneReason, toolCalls) => {
    if (done) return;
    done = true;
    const message = { role: "assistant", content: "" };
    if (toolCalls) message.tool_calls = toolCalls;
    emit(controller, ollamaMessage(model, message, true, doneReason));
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
    const choice = parsed.choices?.[0] || {};
    const delta = choice.delta || {};

    for (const tc of delta.tool_calls || []) {
      pendingToolCalls[tc.index] ||= { function: { name: "", arguments: "" } };
      const acc = pendingToolCalls[tc.index];
      if (tc.function?.name) acc.function.name += tc.function.name;
      if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
    }

    if (delta.content) {
      emit(controller, ollamaMessage(model, { role: "assistant", content: delta.content }, false));
    }

    if (choice.finish_reason) {
      const calls = Object.values(pendingToolCalls);
      pendingToolCalls = {};
      emitDone(controller, choice.finish_reason, calls.length ? toOllamaToolCalls(calls) : null);
    }
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
      if (buffer) handleLine(buffer, controller);
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
