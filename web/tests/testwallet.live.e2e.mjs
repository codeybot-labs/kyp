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
import { KeyPair } from "@near-js/crypto";
import { newAccountId } from "../src/lib/testwallet.mjs";

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
  }).listen(Number(process.env.PORT || 4399)); // fixed origin so the profile's test wallets carry over between runs
  base = `http://localhost:${server.address().port}`;
}
// Persistent profile: test wallets (testnet-only keys) survive between runs instead of being lost
// with their testnet NEAR. Delete PROFILE to start clean.
const ctxP = await chromium.launchPersistentContext(process.env.PROFILE || "/tmp/kyp-live-profile", { executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true });
const page = ctxP.pages()[0] ?? await ctxP.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());
const redact = (s) => String(s).replace(/ed25519:[A-Za-z0-9]+/g, "ed25519:<redacted>");
try {
  await page.goto(`${base}/test-wallets`, { waitUntil: "networkidle" });
  const batch = Number(process.env.BATCH ?? 3), presalers = String(process.env.PRESALERS ?? 3);
  // FUNDERS=a.testnet,b.testnet (box testnet accounts in near-cli's keychain): each funds a fresh
  // test wallet (FUND NEAR) via the testnet registrar; the browser imports it. Exercises the
  // faucet-rate-limit fallback without the faucet. Keys stay in memory; only public keys hit the CLI.
  for (const entry of (process.env.FUNDERS || "").split(",").filter(Boolean)) {
    const [src, fund = process.env.FUND || "7"] = entry.split(":");
    const kp = KeyPair.fromRandom("ed25519"), id = newAccountId("funder");
    execSync(`near account create-account fund-myself ${id} '${fund} NEAR' use-manually-provided-public-key ${kp.getPublicKey().toString()} sign-as ${src} network-config testnet sign-with-legacy-keychain send`, { stdio: "ignore" });
    await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
    await page.fill('[data-testid="tw-import-text"]', JSON.stringify({ account_id: id, private_key: kp.toString() }));
    await page.click('[data-testid="tw-import"]');
    console.log(`funder ${id} created from ${src} and imported`);
  }
  if (batch > 0) {
    await page.selectOption('[data-testid="tw-gen-count"]', String(batch));
    await page.fill('input[placeholder="label (optional)"]', "live");
    await page.click('[data-testid="tw-generate"]');
    await page.waitForFunction(() => !/Creating/.test(document.querySelector('[data-testid="tw-generate"]').textContent), null, { timeout: 120000 });
    const prog = await page.$$eval('[data-testid="tw-progress"] li', (ls) => ls.map((l) => l.textContent));
    console.log(`batch of ${batch}:`, prog.join(" | "));
    if (prog.filter((p) => p.startsWith("✓")).length !== batch) throw new Error("batch incomplete");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="tw-balance"]')].every((b) => /[1-9][0-9.]* NEAR/.test(b.textContent)), null, { timeout: 30000 });
    console.log("batch balances:", (await page.$$eval('[data-testid="tw-log"] li', (ls) => ls.map((l) => l.textContent))).filter((l) => /test wallet/.test(l)).join(" | "));
  }
  if (await page.isEnabled('[data-testid="tw-presalers"]')) await page.selectOption('[data-testid="tw-presalers"]', presalers);
  else console.log("resuming the saved test-mode launch");
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
  for (const l of links) console.log("  tx", l);
  if (process.env.REVEAL) {
    // reveal every wave (interval 60 s), then check caballeros / lock / chart from the chain
    const rpc = "https://rpc.testnet.fastnear.com";
    const view = async (c, m, a) => { const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "optimistic", account_id: c, method_name: m, args_base64: Buffer.from(JSON.stringify(a)).toString("base64") } }) }); const j = await r.json(); if (j.error || j.result?.error) throw new Error(JSON.stringify(j.error ?? j.result.error).slice(0, 200)); return JSON.parse(Buffer.from(j.result.result).toString()); };
    const coord = process.env.KYP_COORD || "kyp-sushmit-dcl.testnet", lock = process.env.KYP_LOCK || "kyp-sushmit-dcl-lock.testnet";
    const L = await view(coord, "get_launch", { launch_id: Number(id) });
    await page.goto(`${base}/test-wallets`, { waitUntil: "networkidle" });
    for (let w = 1; w <= L.reveal.waves; w++) {
      await page.waitForTimeout(62_000);
      const n0 = await page.$$eval('[data-testid="tw-txlink"]', (a) => a.length).catch(() => 0);
      await page.click("text=Reveal next wave");
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="tw-txlink"]').length > n || /failed:/.test(document.querySelector('[data-testid="tw-log"]')?.textContent ?? ""), n0, { timeout: 60000 });
      const last = await page.$$eval('[data-testid="tw-log"] li', (ls) => ls.at(-1).textContent);
      const href = await page.$$eval('[data-testid="tw-txlink"]', (a) => a.at(-1)?.href);
      console.log(`reveal wave ${w}: ${redact(last)} ${/failed/.test(last) ? "" : href}`);
      const pres = await view(coord, "get_presalers", { launch_id: Number(id) });
      console.log(`  caballeros ${pres.length}, waves [${pres.map((p) => p.wave).join(",")}], revealed ${pres.filter((p) => p.account_id).length}`);
    }
    const pres = await view(coord, "get_presalers", { launch_id: Number(id) });
    const prices = pres.map((p) => Number(BigInt(p.tokens) * 10n ** 6n / BigInt(p.quote)));
    console.log("tokens per wNEAR (x1e-6 raw) per caballero:", prices.join(", "), new Set(prices).size === 1 ? "→ one price" : "→ DIFFERENT PRICES");
    const lk = await view(lock, "get_lock", { launch_id: Number(id) });
    const sum = pres.reduce((a, p) => a + BigInt(p.tokens), 0n);
    console.log(`lock: total_locked ${lk.total_locked}, positions ${lk.positions_count}, presale tokens ${sum}, observations ${lk.observations_count}`);
    const tok = await view(L.token_id, "ft_balance_of", { account_id: lock });
    console.log(`lock token balance ${tok} (${BigInt(tok) >= sum ? "holds all presale tokens" : "SHORT"}) · status ${L.status} · pool ${L.pool_id}`);
    await page.goto(`${base}/launch?id=${id}`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="price-chart"] canvas', { timeout: 30000 });
    console.log("chart:", (await page.textContent('[data-testid="price-chart"]')).match(/on-chain[^a#]*|\d+ points/g)?.join(" · "));
  }
  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem("kyp-testnet-wallets")).length);
  console.log(`wallets stored: ${rows}/10`);
  if (errors.length) console.log("page errors:", errors.map(redact));
} catch (e) {
  console.error("LIVE FAILED:", redact(e.message), errors.map(redact));
  process.exitCode = 1;
} finally { await ctxP.close(); server?.close(); }
