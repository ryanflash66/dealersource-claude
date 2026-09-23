// Makes sure Playwright's headless Chromium is present for sources marked `render: js`.
// Used by scripts/run-daily.ps1 after dependencies are installed. Local only, free.
// Exit 0 when the browser launches (installing the Chromium headless shell first if it is
// missing), 1 otherwise. A failure only affects render: js sources; the runner logs it and
// carries on.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const MISSING = /Executable doesn't exist|playwright install|browserType\.launch: .*not found/i;

async function canLaunch() {
  const { chromium } = await import("playwright");
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch (e) {
    if (MISSING.test(String(e?.message ?? e))) return false;
    throw e;
  }
}

try {
  if (await canLaunch()) {
    console.log("playwright chromium: ready");
    process.exit(0);
  }
  console.log("playwright chromium: missing; installing the headless shell (one time)");
  const cli = join(repo, "node_modules", "playwright", "cli.js");
  const r = spawnSync(process.execPath, [cli, "install", "chromium", "--only-shell"], { stdio: "inherit", cwd: repo });
  if (r.status !== 0) {
    console.log(`playwright install exited ${r.status}`);
    process.exit(1);
  }
  const ok = await canLaunch();
  console.log(ok ? "playwright chromium: installed" : "playwright chromium: installed but not launchable");
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.log(`playwright check failed: ${e?.message ?? e}`);
  process.exit(1);
}
