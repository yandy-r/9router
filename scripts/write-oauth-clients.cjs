#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ENTRIES = [
  {
    provider: "gemini",
    keys: ["GEMINI_OAUTH_CLIENT_ID", "GEMINI_OAUTH_CLIENT_SECRET"],
  },
  {
    provider: "antigravity",
    keys: ["ANTIGRAVITY_OAUTH_CLIENT_ID", "ANTIGRAVITY_OAUTH_CLIENT_SECRET"],
  },
  {
    provider: "meta-code",
    keys: ["META_CODE_OAUTH_CLIENT_ID"],
  },
];
const ALL_KEYS = ENTRIES.flatMap(({ keys }) => keys);
const FILE_NAME = "oauth-clients.json";

function writeOAuthClients(outDir, env = process.env) {
  const clients = {};
  const providers = [];

  for (const { provider, keys } of ENTRIES) {
    const values = keys.map((key) => (typeof env[key] === "string" ? env[key].trim() : ""));
    if (values.every(Boolean)) {
      providers.push(provider);
      keys.forEach((key, index) => {
        clients[key] = values[index];
      });
    }
  }

  const writtenKeys = Object.keys(clients);
  if (writtenKeys.length === 0) {
    console.warn(
      "OAuth client defaults were not embedded; gemini/gemini-cli/antigravity/meta-code login needs environment variables at runtime.",
    );
    return [];
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, FILE_NAME);
  fs.writeFileSync(outputPath, `${JSON.stringify(clients, null, 2)}\n`, { mode: 0o644 });
  fs.chmodSync(outputPath, 0o644);
  console.log(`Embedded OAuth client defaults for: ${providers.join(", ")}`);
  return writtenKeys;
}

function checkOAuthClients(dir) {
  try {
    const clients = JSON.parse(fs.readFileSync(path.join(dir, FILE_NAME), "utf8"));
    return ALL_KEYS.every(
      (key) => typeof clients[key] === "string" && clients[key].trim().length > 0,
    );
  } catch {
    return false;
  }
}

function usage() {
  console.error(
    "Usage: node scripts/write-oauth-clients.cjs <outDir>\n" +
      "       node scripts/write-oauth-clients.cjs --check <dir>",
  );
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] !== "--check") {
    writeOAuthClients(args[0]);
  } else if (args.length === 2 && args[0] === "--check") {
    if (!checkOAuthClients(args[1])) {
      console.error(
        `OAuth defaults check failed: ${path.join(args[1], FILE_NAME)} is missing or incomplete.`,
      );
      process.exitCode = 1;
    }
  } else {
    usage();
    process.exitCode = 2;
  }
}

module.exports = { writeOAuthClients, checkOAuthClients };
