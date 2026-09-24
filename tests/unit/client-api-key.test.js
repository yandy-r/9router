import { describe, it, expect } from "vitest";
import { extractClientApiKey } from "../../src/lib/auth/clientApiKey.js";

function request(url, headers = {}) {
  return { headers: new Headers(headers), url };
}

describe("extractClientApiKey", () => {
  it("prefers Bearer over x-api-key, x-goog-api-key, and ?key=", () => {
    const req = request("http://localhost/v1beta/models?key=query-key", {
      authorization: "Bearer bearer-key",
      "x-api-key": "header-key",
      "x-goog-api-key": "google-key",
    });
    expect(extractClientApiKey(req)).toBe("bearer-key");
  });

  it("reads x-goog-api-key after x-api-key", () => {
    const req = request("http://localhost/v1beta/models?key=query-key", {
      "x-goog-api-key": "google-key",
    });
    expect(extractClientApiKey(req)).toBe("google-key");
  });

  it("reads ?key= query param", () => {
    expect(extractClientApiKey(request("http://localhost/v1beta/models?key=query-key"))).toBe(
      "query-key",
    );
  });

  it("returns null when no key is present", () => {
    expect(extractClientApiKey(request("http://localhost/v1beta/models"))).toBeNull();
  });

  it("returns null for missing or invalid url", () => {
    expect(extractClientApiKey({ headers: new Headers() })).toBeNull();
    expect(extractClientApiKey({ headers: new Headers(), url: "not a url" })).toBeNull();
  });
});
