import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Drive createBypassRequest (DNS-bypass path for MITM_BYPASS_HOSTS) without network.
const state = vi.hoisted(() => ({ res: null, req: null, onResponse: null }));

vi.mock("dns", () => {
  class Resolver {
    setServers() {}
    resolve4(_host, cb) {
      cb(null, ["127.0.0.1"]);
    }
  }
  return { default: { Resolver }, Resolver };
});

vi.mock("net", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Socket extends Emitter {
    connect(_port, _ip, cb) {
      queueMicrotask(cb);
    }
    destroy() {
      this.emit("close");
    }
  }
  return { default: { Socket }, Socket };
});

vi.mock("https", () => {
  const request = (_opts, onResponse) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {};
    req.destroy = vi.fn();
    state.req = req;
    state.onResponse = onResponse;
    return req;
  };
  return { default: { request }, request };
});

// proxyFetch captures fetch at import as its non-bypass fallback; keep tests offline.
const fallbackFetch = vi.fn(async () => new Response("fallback", { status: 502 }));
globalThis.fetch = fallbackFetch;
const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");
const URL_BYPASS = "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
const flush = () => new Promise((r) => setTimeout(r, 0));

function respond(statusCode, headers, chunks) {
  const res = new PassThrough();
  res.statusCode = statusCode;
  res.statusMessage = "X";
  res.headers = headers;
  state.res = res;
  state.onResponse(res);
  for (const c of chunks) res.write(c);
  res.end();
}

describe("proxyFetch DNS-bypass request", () => {
  beforeEach(() => {
    state.res = state.req = state.onResponse = null;
  });

  it("returns a real Response: clone() works and body survives awaits", async () => {
    const pending = proxyAwareFetch(URL_BYPASS, { method: "POST", body: "{}" });
    await flush();
    respond(403, { "content-type": "application/json", "set-cookie": ["a=1", "b=2"] }, [
      '{"error":',
      '"reset after 2h7m"}',
    ]);
    const res = await pending;
    await flush();
    expect(res).toBeInstanceOf(Response);
    expect(res.ok).toBe(false);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.clone().text()).toContain("reset after 2h7m");
    expect(await res.json()).toEqual({ error: "reset after 2h7m" });
  });

  it("aborts via options.signal before and after the response arrives", async () => {
    const pre = new AbortController();
    pre.abort(new Error("pre"));
    await expect(proxyAwareFetch(URL_BYPASS, { signal: pre.signal })).rejects.toThrow("pre");

    const ctrl = new AbortController();
    const pending = proxyAwareFetch(URL_BYPASS, { signal: ctrl.signal });
    await flush();
    const res = new PassThrough();
    Object.assign(res, { statusCode: 200, statusMessage: "OK", headers: {} });
    state.onResponse(res);
    const response = await pending;
    const reading = response.text();
    ctrl.abort(new Error("stall"));
    await expect(reading).rejects.toThrow("stall");
    expect(state.req.destroy).toHaveBeenCalled();
  });

  it("rejects while waiting for headers when aborted", async () => {
    const ctrl = new AbortController();
    const pending = proxyAwareFetch(URL_BYPASS, { signal: ctrl.signal });
    await flush();
    ctrl.abort(new Error("connect timeout"));
    await expect(pending).rejects.toThrow("connect timeout");
    expect(fallbackFetch).not.toHaveBeenCalled();
  });

  it("handles null-body statuses", async () => {
    const pending = proxyAwareFetch(URL_BYPASS, {});
    await flush();
    respond(204, {}, []);
    const res = await pending;
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("falls back instead of hanging on statuses a Response cannot represent", async () => {
    const pending = proxyAwareFetch(URL_BYPASS, {});
    await flush();
    respond(101, {}, []);
    expect(await (await pending).text()).toBe("fallback");
  });
});
