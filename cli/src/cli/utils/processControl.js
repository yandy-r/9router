// Process helpers for the launcher. Everything here targets processes by PID
// (PID file or exact listening port), never by substring-matching `ps` output,
// which used to SIGKILL unrelated Next.js apps, shells, and port clients.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { getDataDir } = require("../../../hooks/sqliteRuntime");

const isPid = (pid) => Number.isInteger(pid) && pid > 0;

// Resolved per call so DATA_DIR changes (tests, env) are honoured.
function getPidFilePath() {
  return path.join(getDataDir(), "9router.pid");
}

function readPidFile() {
  try {
    const { launcher, server } = JSON.parse(fs.readFileSync(getPidFilePath(), "utf8"));
    return { launcher: isPid(launcher) ? launcher : null, server: isPid(server) ? server : null };
  } catch {
    return null;
  }
}

function writePidFile({ launcher, server }) {
  const file = getPidFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ launcher, server }));
}

// Only the launcher that wrote the file may remove it (a newer launcher may own it now).
function removePidFileIfOwner(pid) {
  if (readPidFile()?.launcher !== pid) return false;
  try {
    fs.unlinkSync(getPidFilePath());
    return true;
  } catch {
    return false;
  }
}

function getCommandLine(pid) {
  if (!isPid(pid)) return null;
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null;
    }
    const out =
      process.platform === "win32"
        ? execFileSync(
            "powershell",
            [
              "-NonInteractive",
              "-Command",
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
            ],
            { encoding: "utf8", windowsHide: true, timeout: 5000 },
          )
        : execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
            encoding: "utf8",
            timeout: 5000,
          });
    return out.trim() || null;
  } catch {
    return null;
  }
}

// `netstat -ano` rows: Proto  Local  Foreign  State  PID. Match the local port exactly
// (`findstr :80` also matched :8080) and only LISTENING rows (not connected clients).
function parseListeningPidsWindows(output, port) {
  const pids = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP" || cols[3] !== "LISTENING") continue;
    const local = cols[1];
    const pid = Number(cols[4]);
    if (local.slice(local.lastIndexOf(":") + 1) === String(port) && isPid(pid)) pids.add(pid);
  }
  return [...pids];
}

function findListeningPids(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      return parseListeningPidsWindows(out, port);
    }
    // -sTCP:LISTEN: `lsof -ti:PORT` also returns clients connected to that port.
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    return [...new Set(out.split("\n").map(Number).filter(isPid))];
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// SIGTERM first (graceful) so the target can run its own cleanup, then SIGKILL.
function killPid(pid, { graceful = true } = {}) {
  if (!isPid(pid) || pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 3000,
      });
      return;
    }
    if (graceful) {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && isAlive(pid)) sleepSync(100);
      if (!isAlive(pid)) return;
    }
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead or not ours */
  }
}

module.exports = {
  getPidFilePath,
  readPidFile,
  writePidFile,
  removePidFileIfOwner,
  getCommandLine,
  parseListeningPidsWindows,
  findListeningPids,
  isAlive,
  killPid,
};
