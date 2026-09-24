import { createRequire } from "module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parseLauncherArgs } = require("../../cli/src/cli/utils/args.js");

describe("parseLauncherArgs", () => {
  it("returns defaults", () => {
    expect(parseLauncherArgs([])).toEqual({
      port: 20128,
      host: "0.0.0.0",
      noBrowser: false,
      showLog: false,
      trayMode: false,
      help: false,
      version: false,
    });
  });

  it.each([[["--port=3000", "--host=127.0.0.1"]], [["-p3000", "-H", "127.0.0.1"]]])(
    "parses port/host forms %j",
    (argv) => {
      expect(parseLauncherArgs(argv)).toMatchObject({ port: 3000, host: "127.0.0.1" });
    },
  );

  it("parses short boolean flags", () => {
    expect(parseLauncherArgs(["-p", "3000", "-t", "-n", "-l"])).toMatchObject({
      port: 3000,
      trayMode: true,
      noBrowser: true,
      showLog: true,
    });
  });

  it.each([
    [["--port=abc"], /Invalid --port/],
    [["--port=0"], /Invalid --port/],
    [["--port=70000"], /Invalid --port/],
    [["--bogus"], /bogus/],
    [["--host", "a b"], /Invalid --host/],
    [["--host", "$(x)"], /Invalid --host/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseLauncherArgs(argv)).toThrow(message);
  });
});
