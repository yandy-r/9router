import { getSettings, validateApiKey } from "@/lib/localDb";
import { errorResponse } from "open-sse/utils/error.js";
import { extractClientApiKey } from "./clientApiKey.js";
import { hasValidCliToken } from "./cliToken.js";

/**
 * Enforce `settings.requireApiKey` for a /v1 route that has no handler-level check.
 * The local CLI launcher authenticates with its machine-bound CLI token instead.
 * @param {Request} request
 * @returns {Promise<Response|null>} 401 response when denied, null when allowed.
 */
export async function requireClientApiKey(request) {
  const settings = await getSettings();
  if (!settings.requireApiKey) return null;
  if (await hasValidCliToken(request)) return null;

  const apiKey = extractClientApiKey(request);
  if (!apiKey) return errorResponse(401, "Missing API key");
  if (!(await validateApiKey(apiKey))) return errorResponse(401, "Invalid API key");
  return null;
}
