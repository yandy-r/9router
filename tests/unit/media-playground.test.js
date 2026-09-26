import { describe, it, expect } from "vitest";
import {
  playgroundDefaults,
  playgroundModelOptions,
  resolvePlaygroundModel,
  buildPlaygroundBody,
  buildSttFormData,
  playgroundHeaders,
  playgroundPreviews,
} from "@/app/(dashboard)/dashboard/media-providers/components/playgroundLogic.js";

describe("playgroundDefaults", () => {
  it("returns kind defaults and falls back to image", () => {
    expect(playgroundDefaults("embedding").path).toBe("/v1/embeddings");
    expect(playgroundDefaults("tts").path).toBe("/v1/audio/speech");
    expect(playgroundDefaults("stt").path).toBe("/v1/audio/transcriptions");
    expect(playgroundDefaults("unknown").path).toBe("/v1/images/generations");
  });
});

describe("resolvePlaygroundModel", () => {
  it("keeps the current model when still available", () => {
    const options = [{ value: "a/x" }, { value: "b/y" }];
    expect(resolvePlaygroundModel("b/y", options)).toBe("b/y");
  });

  it("falls back to the first option otherwise", () => {
    const options = [{ value: "a/x" }, { value: "b/y" }];
    expect(resolvePlaygroundModel("stale", options)).toBe("a/x");
    expect(resolvePlaygroundModel("", options)).toBe("a/x");
  });

  it("returns empty string when no options exist", () => {
    expect(resolvePlaygroundModel("x", [])).toBe("x");
  });
});

describe("buildPlaygroundBody", () => {
  it("builds embedding payload with dimensions only when positive", () => {
    const base = { kind: "embedding", model: "m/e", input: " hi ", dimensions: "512" };
    expect(buildPlaygroundBody(base)).toEqual({ model: "m/e", input: "hi", dimensions: 512 });
    expect(buildPlaygroundBody({ ...base, dimensions: "" })).toEqual({
      model: "m/e",
      input: "hi",
    });
    expect(buildPlaygroundBody({ ...base, dimensions: "0" })).toEqual({
      model: "m/e",
      input: "hi",
    });
  });

  it("builds image payload with size and optional images", () => {
    const body = buildPlaygroundBody({
      kind: "image",
      model: "m/i",
      input: "cat",
      imageSize: "1024x1024",
      refImage: " https://x/a.png ",
      maskImage: "",
    });
    expect(body).toEqual({
      model: "m/i",
      prompt: "cat",
      size: "1024x1024",
      image: "https://x/a.png",
    });
  });

  it("builds tts payload with voice/language/style", () => {
    const body = buildPlaygroundBody({
      kind: "tts",
      model: "m/t",
      input: "hello",
      ttsVoice: "alloy",
      ttsLanguage: "en",
      ttsStyle: " warm ",
    });
    expect(body).toEqual({
      model: "m/t",
      input: "hello",
      voice: "alloy",
      language: "en",
      style: "warm",
    });
  });

  it("builds stt payload with language/temperature/format", () => {
    const body = buildPlaygroundBody({
      kind: "stt",
      model: "m/s",
      input: "ctx",
      sttLanguage: "vi",
      sttTemp: "0.2",
      sttFormat: "text",
    });
    expect(body).toEqual({
      model: "m/s",
      prompt: "ctx",
      language: "vi",
      temperature: 0.2,
      response_format: "text",
    });
  });

  it("builds web payloads with query/url keys", () => {
    expect(buildPlaygroundBody({ kind: "webSearch", model: "m", input: " q " })).toEqual({
      model: "m",
      query: "q",
    });
    expect(buildPlaygroundBody({ kind: "webFetch", model: "m", input: " https://x " })).toEqual({
      model: "m",
      url: "https://x",
    });
  });
});

describe("playgroundHeaders", () => {
  it("includes auth and connection pin headers", () => {
    expect(playgroundHeaders("sk-1", "conn-9", true)).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-1",
      "x-connection-id": "conn-9",
    });
    expect(playgroundHeaders("", "", false)).toEqual({});
  });
});

describe("buildSttFormData", () => {
  it("appends file, model and optional params", () => {
    const file = new Blob(["audio"], { type: "audio/mpeg" });
    const fd = buildSttFormData({
      model: "m/s",
      input: "ctx",
      sttFile: file,
      sttLanguage: "en",
      sttTemp: "0.1",
      sttFormat: "json",
    });
    expect(fd.get("model")).toBe("m/s");
    expect(fd.get("file")).toBeInstanceOf(Blob);
    expect(fd.get("file").size).toBe(5);
    expect(fd.get("language")).toBe("en");
    expect(fd.get("temperature")).toBe("0.1");
    expect(fd.get("response_format")).toBe("json");
    expect(fd.get("prompt")).toBe("ctx");
  });
});

describe("playgroundPreviews", () => {
  it("derives image/audio preview URLs", () => {
    expect(playgroundPreviews({ data: [{ b64_json: "abc" }] })).toEqual({
      imageUrl: "data:image/png;base64,abc",
      audioUrl: "",
    });
    expect(playgroundPreviews({ data: [{ url: "https://x/i.png" }] })).toEqual({
      imageUrl: "https://x/i.png",
      audioUrl: "",
    });
    expect(playgroundPreviews({ audio: "zzz" })).toEqual({
      imageUrl: "",
      audioUrl: "data:audio/mp3;base64,zzz",
    });
    expect(playgroundPreviews(null)).toEqual({ imageUrl: "", audioUrl: "" });
  });
});

describe("playgroundModelOptions", () => {
  it("returns selectable options for a kind", () => {
    const options = playgroundModelOptions("embedding");
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toHaveProperty("value");
    expect(options[0]).toHaveProperty("label");
  });
});
