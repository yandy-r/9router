import { GEMINI_CONFIG, getOAuthClientMetadata } from "../constants/oauth.js";
import { assertOAuthClient } from "open-sse/providers/shared.js";

const geminiCli = {
  config: GEMINI_CONFIG,
  // Runs before both buildAuthUrl and exchangeToken (see providers/index.js).
  prepareConfig: (config) => {
    assertOAuthClient(config, "gemini");
    return config;
  },
  flowType: "authorization_code",
  buildAuthUrl: (config, redirectUri, state) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  postExchange: async (tokens) => {
    // Fetch user info
    const userInfoRes = await fetch(`${GEMINI_CONFIG.userInfoUrl}?alt=json`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

    // Fetch project ID
    let projectId = "";
    let tierId = null;
    try {
      const projectRes = await fetch(
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokens.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            metadata: getOAuthClientMetadata(),
            mode: 1,
          }),
        },
      );
      if (projectRes.ok) {
        const data = await projectRes.json();
        projectId = data.cloudaicompanionProject?.id || data.cloudaicompanionProject || "";
        tierId = data.currentTier?.id || data.currentTier?.name || null;
      }
    } catch (e) {
      console.log("Failed to fetch project ID:", e);
    }

    return { userInfo, projectId, tierId };
  },
  mapTokens: (tokens, extra) => {
    const planTier =
      typeof extra?.tierId === "string" ? extra.tierId.trim().toLowerCase().slice(0, 64) : "";
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
      email: extra?.userInfo?.email,
      projectId: extra?.projectId,
      ...(planTier ? { providerSpecificData: { planTier } } : {}),
    };
  },
};

export default geminiCli;
