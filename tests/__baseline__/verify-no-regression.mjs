// Gate: so kết quả test hiện tại với baseline known-fails.
// PASS nếu KHÔNG có test nào pass(baseline) → fail(now). Test mới được phép.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { relative, sep } from "path";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map(s => s.trim()).filter(Boolean)
);

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

// Key tests by repo-relative POSIX path so the list matches on any checkout/OS.
const testKey = (file) => relative(repoRoot, file).split(sep).join("/");

const r = JSON.parse(readFileSync(resultsPath, "utf8"));
// A file can fail with no failed assertion (import error, empty suite, throwing
// hook). Key those as `<path> :: <file>` so a broken setup can't pass the gate.
const nowFails = r.testResults.flatMap(f => {
  const failed = f.assertionResults.filter(a => a.status === "failed")
    .map(a => testKey(f.name) + " :: " + a.fullName);
  return failed.length || f.status !== "failed" ? failed : [testKey(f.name) + " :: <file>"];
});

// Regression = fail bây giờ NHƯNG không có trong baseline known-fails
const regressions = nowFails.filter(f => !knownFails.has(f));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`✅ No regression. (now fails=${nowFails.length}, baseline known=${knownFails.size}, all known)`);
