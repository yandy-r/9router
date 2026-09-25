import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { adjustMaxTokens } from "../formats/maxTokens.js";
import { encodeDataUri } from "../concerns/image.js";
import { collapseTextParts } from "../concerns/message.js";
import { createToolIdPairer } from "../concerns/toolCall.js";
import { ROLE, GEMINI_ROLE, OPENAI_BLOCK } from "../schema/index.js";

// Convert Gemini request to OpenAI format
export function geminiToOpenAIRequest(model, body, stream) {
  const result = {
    model: model,
    messages: [],
    stream: stream,
  };

  // Generation config
  if (body.generationConfig) {
    const config = body.generationConfig;
    if (config.maxOutputTokens) {
      const tempBody = { max_tokens: config.maxOutputTokens, tools: body.tools };
      result.max_tokens = adjustMaxTokens(tempBody);
    }
    if (config.temperature !== undefined) {
      result.temperature = config.temperature;
    }
    if (config.topP !== undefined) {
      result.top_p = config.topP;
    }
  }

  // System instruction
  if (body.systemInstruction) {
    const systemText = extractGeminiText(body.systemInstruction);
    if (systemText) {
      result.messages.push({
        role: ROLE.SYSTEM,
        content: systemText,
      });
    }
  }

  // Convert contents to messages
  if (body.contents && Array.isArray(body.contents)) {
    const pairer = createToolIdPairer();
    for (const content of body.contents) {
      const converted = convertGeminiContent(content, pairer);
      if (converted) {
        if (Array.isArray(converted)) {
          result.messages.push(...converted);
        } else {
          result.messages.push(converted);
        }
      }
    }
  }

  // Tools
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = [];
    for (const tool of body.tools) {
      if (tool.functionDeclarations) {
        for (const func of tool.functionDeclarations) {
          result.tools.push({
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name: func.name,
              description: func.description || "",
              parameters: func.parameters || { type: "object", properties: {} },
            },
          });
        }
      }
    }
  }

  return result;
}

// Convert Gemini content to OpenAI message.
// functionResponse parts become tool messages; co-located text/calls stay on an assistant message.
function convertGeminiContent(content, pairer) {
  const role = content.role === GEMINI_ROLE.USER ? ROLE.USER : ROLE.ASSISTANT;

  if (!content.parts || !Array.isArray(content.parts)) {
    return null;
  }

  const parts = [];
  const toolCalls = [];
  const toolResults = [];

  for (const part of content.parts) {
    if (part.text !== undefined) {
      parts.push({ type: OPENAI_BLOCK.TEXT, text: part.text });
    }

    if (part.inlineData) {
      parts.push({
        type: OPENAI_BLOCK.IMAGE_URL,
        image_url: {
          url: encodeDataUri(part.inlineData.mimeType, part.inlineData.data),
        },
      });
    }

    if (part.functionCall) {
      toolCalls.push({
        id: pairer.callId(part.functionCall),
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }

    if (part.functionResponse) {
      toolResults.push({
        role: ROLE.TOOL,
        tool_call_id: pairer.responseId(part.functionResponse),
        content: JSON.stringify(
          part.functionResponse.response?.result || part.functionResponse.response || {},
        ),
      });
    }
  }

  if (toolResults.length > 0) {
    if (toolCalls.length > 0 || parts.length > 0) {
      const assistantMsg = { role: ROLE.ASSISTANT };
      if (parts.length > 0) {
        assistantMsg.content = parts.length === 1 ? parts[0].text : parts;
      }
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      return [...toolResults, assistantMsg];
    }
    return toolResults;
  }

  if (toolCalls.length > 0) {
    const result = { role: ROLE.ASSISTANT };
    if (parts.length > 0) {
      result.content = parts.length === 1 ? parts[0].text : parts;
    }
    result.tool_calls = toolCalls;
    return result;
  }

  if (parts.length > 0) {
    return {
      role,
      content: collapseTextParts(parts),
    };
  }

  return null;
}

// Extract text from Gemini content
function extractGeminiText(content) {
  if (typeof content === "string") return content;
  if (content.parts && Array.isArray(content.parts)) {
    return content.parts.map((p) => p.text || "").join("");
  }
  return "";
}

// Register
register(FORMATS.GEMINI, FORMATS.OPENAI, geminiToOpenAIRequest, null);
register(FORMATS.GEMINI_CLI, FORMATS.OPENAI, geminiToOpenAIRequest, null);
