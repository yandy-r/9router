import { AI_PROVIDERS } from "@/shared/constants/providers";
import { requireClientApiKey } from "@/lib/auth/requireClientApiKey";
import { GET as getGenericVoices } from "@/app/api/media-providers/tts/voices/route.js";
import { GET as getElevenLabsVoices } from "@/app/api/media-providers/tts/elevenlabs/voices/route.js";
import { GET as getDeepgramVoices } from "@/app/api/media-providers/tts/deepgram/voices/route.js";
import { GET as getInworldVoices } from "@/app/api/media-providers/tts/inworld/voices/route.js";

// Provider → internal voices handler, called in-process: an HTTP self-fetch
// would hit the login-gated /api/media-providers path without credentials.
// Edge/local-device share the generic handler.
// ponytail: reuses route handlers directly; extract a voices lib if more callers appear.
const PROVIDER_API = {
  elevenlabs: { handler: getElevenLabsVoices, path: "elevenlabs/voices" },
  deepgram: { handler: getDeepgramVoices, path: "deepgram/voices" },
  inworld: { handler: getInworldVoices, path: "inworld/voices" },
  "edge-tts": { handler: getGenericVoices, path: "voices?provider=edge-tts" },
  "local-device": { handler: getGenericVoices, path: "voices?provider=local-device" },
};

export async function OPTIONS() {
  return new Response(null, {
    headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS" },
  });
}

// GET /v1/audio/voices?provider={p}[&lang=xx]
// Returns OpenAI-style list with each voice's full model id ready for /v1/audio/speech
export async function GET(request) {
  const denied = await requireClientApiKey(request);
  if (denied) return denied;
  try {
    const { searchParams, origin } = new URL(request.url);
    const provider = searchParams.get("provider");
    const lang = searchParams.get("lang");

    if (!provider || !PROVIDER_API[provider]) {
      return Response.json(
        {
          error: {
            message: `provider must be one of: ${Object.keys(PROVIDER_API).join(", ")}`,
            type: "invalid_request_error",
          },
        },
        { status: 400, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    const { handler, path } = PROVIDER_API[provider];
    const baseUrl = `${origin}/api/media-providers/tts/${path}`;
    const url = lang
      ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}lang=${encodeURIComponent(lang)}`
      : baseUrl;
    const res = await handler(new Request(url));
    const data = await res.json();
    if (!res.ok || data.error) {
      return Response.json(
        { error: { message: data.error || `Upstream ${res.status}`, type: "server_error" } },
        { status: res.status, headers: { "Access-Control-Allow-Origin": "*" } },
      );
    }

    // Internal API shape: { voices } when lang filter, else { byLang, languages }
    const rawVoices = lang
      ? data.voices || []
      : Object.values(data.byLang || {}).flatMap((l) => l.voices || []);

    // Use provider alias for /v1/audio/speech model param (matches skill convention e.g. el/, dg/, edge-tts/)
    const alias = AI_PROVIDERS[provider]?.alias || provider;
    const data_out = rawVoices.map((v) => ({
      id: v.id,
      name: v.name,
      lang: v.lang || "",
      gender: v.gender || "",
      model: `${alias}/${v.id}`,
    }));

    return Response.json(
      { object: "list", data: data_out },
      {
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  } catch (err) {
    return Response.json(
      { error: { message: err.message || "Failed", type: "server_error" } },
      { status: 502, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }
}
