// YAN-87: large /etc/hosts must not be inlined into the `sh -c` command (E2BIG).
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const cp = require("child_process");
const fs = require("fs");
const orig = { spawn: cp.spawn, execSync: cp.execSync, readFileSync: fs.readFileSync };

afterEach(() => {
  cp.spawn = orig.spawn;
  cp.execSync = orig.execSync;
  fs.readFileSync = orig.readFileSync;
});

describe.skipIf(process.platform === "win32")("MITM hosts write", () => {
  it("writes a large hosts file via a temp file, not the command line", async () => {
    const bigHosts = "0.0.0.0 ads.example\n".repeat(20000); // ~400KB
    const writes = []; // { command, tmp, content }
    cp.execSync = () => ""; // `command -v sudo` succeeds
    cp.spawn = (_bin, args) => {
      const command = args.at(-1);
      const tmp = command.match(/^cat '(.+)' > \/etc\/hosts$/)?.[1];
      if (tmp) writes.push({ command, tmp, content: orig.readFileSync(tmp, "utf8") });
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        stdin: { write() {}, end() {} },
      });
      setImmediate(() => child.emit("close", 0));
      return child;
    };
    fs.readFileSync = (p, ...rest) =>
      p === "/etc/hosts" ? bigHosts : orig.readFileSync(p, ...rest);

    const modPath = require.resolve("../../src/mitm/dns/dnsConfig.js");
    delete require.cache[modPath];
    const { addDNSEntry, TOOL_HOSTS } = require(modPath);
    await addDNSEntry("cursor", "pw");

    expect(writes).toHaveLength(1);
    const [{ command, tmp, content }] = writes;
    expect(command.length).toBeLessThan(1024);
    expect(content.startsWith(bigHosts.trimEnd())).toBe(true);
    expect(content).toContain(`127.0.0.1 ${TOOL_HOSTS.cursor[0]}`);
    expect(fs.existsSync(tmp)).toBe(false);
  });
});
