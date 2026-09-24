// YAN-53: malformed chat bodies → 400, not 500.
// YAN-112: device-code poll survives a non-JSON token response.
import { describe, expect, it } from "vitest";

import { readTokenResponse } from "../../src/lib/oauth/providerHelpers.js";
import { updateSettings } from "../../src/lib/localDb.js";
import { handleChat } from "../../src/sse/handlers/chat.js";

const post = (body) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

describe("handleChat body validation (YAN-53)", () => {
  it.each([["null"], ['{"model":123,"messages":[]}'], ["[]"]])("rejects %s with 400", async (b) => {
    await updateSettings({ requireApiKey: false });
    const res = await handleChat(post(b));
    expect(res.status).toBe(400);
  });
});

describe("readTokenResponse (YAN-112)", () => {
  it("returns invalid_response for a non-JSON body instead of throwing", async () => {
    const data = await readTokenResponse(new Response("<html>502</html>", { status: 502 }));
    expect(data).toEqual({ error: "invalid_response", error_description: "<html>502</html>" });
  });

  it("parses JSON bodies", async () => {
    const data = await readTokenResponse(Response.json({ error: "authorization_pending" }));
    expect(data).toEqual({ error: "authorization_pending" });
  });
});
