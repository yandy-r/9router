const { parseArgs } = require("util");

const DEFAULT_PORT = 20128;
const DEFAULT_HOST = "0.0.0.0";

function parseLauncherArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      port: { type: "string", short: "p" },
      host: { type: "string", short: "H" },
      "no-browser": { type: "boolean", short: "n" },
      log: { type: "boolean", short: "l" },
      tray: { type: "boolean", short: "t" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port)) {
      throw new Error(`Invalid --port "${values.port}": expected an integer between 1 and 65535`);
    }
    const n = Number(values.port);
    if (n < 1 || n > 65535) {
      throw new Error(`Invalid --port "${values.port}": expected an integer between 1 and 65535`);
    }
    port = n;
  }

  let host = DEFAULT_HOST;
  if (values.host !== undefined) {
    // Allow-list keeps host safe to embed in autostart plist/VBS/.desktop entries.
    if (!values.host || !/^[A-Za-z0-9.:%_-]+$/.test(values.host)) {
      throw new Error(`Invalid --host "${values.host}"`);
    }
    host = values.host;
  }

  return {
    port,
    host,
    noBrowser: values["no-browser"] || false,
    showLog: values.log || false,
    trayMode: values.tray || false,
    help: values.help || false,
    version: values.version || false,
  };
}

module.exports = { parseLauncherArgs, DEFAULT_PORT, DEFAULT_HOST };
