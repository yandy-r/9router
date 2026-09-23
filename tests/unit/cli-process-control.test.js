import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const pc = require("../../cli/src/cli/utils/processControl.js");

describe("parseListeningPidsWindows", () => {
  it("matches only LISTENING rows on the exact local port", () => {
    const netstat = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:80             0.0.0.0:0              LISTENING       111",
      "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       222",
      "  TCP    [::]:80                [::]:0                 LISTENING       111",
      "  TCP    127.0.0.1:80           127.0.0.1:50000        ESTABLISHED     333",
      "  TCP    127.0.0.1:50000        127.0.0.1:80           ESTABLISHED     444",
      "  UDP    0.0.0.0:80             *:*                                    555",
    ].join("\r\n");
    expect(pc.parseListeningPidsWindows(netstat, 80)).toEqual([111]);
    expect(pc.parseListeningPidsWindows(netstat, 8080)).toEqual([222]);
    expect(pc.parseListeningPidsWindows(netstat, 8)).toEqual([]);
  });
});

describe("isLauncherCommandLine", () => {
  it("accepts node running a 9router launcher script only", () => {
    for (const cmd of [
      "node /usr/local/bin/9router",
      "/usr/bin/node --dns-result-order=ipv4first /home/u/.npm/lib/node_modules/9router/cli.js --tray -p 20128",
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\9router\\cli.js"',
    ]) {
      expect(pc.isLauncherCommandLine(cmd)).toBe(true);
    }
    for (const cmd of [
      "bash -lc cd /home/u/src/9router && python -m http.server 20128",
      "/bin/zsh -c cd /home/u/9router && npx vitest run",
      "node /home/u/9router/node_modules/vitest/vitest.mjs run",
      "next-server (v16.3.6)",
      "",
      null,
    ]) {
      expect(pc.isLauncherCommandLine(cmd)).toBe(false);
    }
  });
});

describe("launcher PID file", () => {
  it("round-trips under DATA_DIR and is only removed by its owner", () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9r-pid-"));
    expect(pc.getPidFilePath()).toBe(path.join(process.env.DATA_DIR, "9router.pid"));
    expect(pc.readPidFile()).toBeNull();

    pc.writePidFile({ launcher: 100, server: 200 });
    expect(pc.readPidFile()).toEqual({ launcher: 100, server: 200 });
    expect(pc.removePidFileIfOwner(999)).toBe(false);
    expect(pc.removePidFileIfOwner(100)).toBe(true);
    expect(fs.existsSync(pc.getPidFilePath())).toBe(false);

    fs.writeFileSync(pc.getPidFilePath(), "not json");
    expect(pc.readPidFile()).toBeNull();
  });
});
