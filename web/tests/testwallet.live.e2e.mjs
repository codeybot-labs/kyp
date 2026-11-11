// LIVE testnet browser check (opt-in, spends faucet testnet NEAR only): builds the production
// config, opens /test-wallets in Chrome, and runs the Test mode quick start against the real
// testnet contracts, signing in the browser. Usage: npm run test:live   (BASE_URL=https://… to test a deployed site)
// Never prints keys.
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

let base = process.env.BASE_URL, server;
if (!base) {
  const out = mkdtempSync(path.join(tmpdir(), "kyp-live-"));
  execSync(`npx astro build --outDir ${out}`, { stdio: "ignore" });
  server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
    let f = path.join(out, p); if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
    if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  }).listen(0);
  base = `http://localhost:${server.address().port}`;
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true });
const page = await (await browser.newContext()).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const redact = (s) => String(s).replace(/ed25519:[A-Za-z0-9]+/g, "ed25519:<redacted>");
try {
  await page.goto(`${base}/test-wallets`, { waitUntil: "networkidle" });
  await page.click('[data-testid="tw-quickstart"]');
  const t0 = Date.now();
  let last = 0;
  for (;;) {
    await page.waitForTimeout(3000);
    const lines = await page.$$eval('[data-testid="tw-log"] li', (ls) => ls.map((l) => l.textContent));
    for (const l of lines.slice(last)) console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s  ${redact(l)}`);
    last = lines.length;
    if (lines.some((l) => /failed:/.test(l))) throw new Error("quick start step failed");
    if (lines.some((l) => /record TWAP observation 3\/3/.test(l))) break;
    if (Date.now() - t0 > 300_000) throw new Error("timeout");
  }
  const links = await page.$$eval('[data-testid="tw-txlink"]', (as) => as.map((a) => a.href));
  const st = await page.textContent('[data-testid="tw-qs-state"]');
  const id = /#(\d+) status/.exec(st)?.[1];
  await page.goto(`${base}/launch?id=${id}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => /Live/.test(document.body.innerText), null, { timeout: 30000 });
  console.log(`OK: ${links.length} tx links, launch #${id} Live on ${base}`);
  if (errors.length) console.log("page errors:", errors.map(redact));
} catch (e) {
  console.error("LIVE FAILED:", redact(e.message), errors.map(redact));
  process.exitCode = 1;
} finally { await browser.close(); server?.close(); }
