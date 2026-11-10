// Headless browser check of wallet login + wallet-signed writes, against a MOCKED testnet:
// RPC view calls are answered from fixtures and a fake "KYP Test Wallet" is injected through
// NEAR Connect's standard `near-wallet-injected` event. Nothing is signed or sent to a chain.
// Run: npm run test:e2e   (needs Chrome; set CHROME_PATH if it isn't /usr/bin/google-chrome)
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const COORD = "kyp-coord.testnet", LOCK = "kyp-lock.testnet", LAUNCHER = "boss.testnet", PRESALER = "ana.testnet";
const out = mkdtempSync(path.join(tmpdir(), "kyp-e2e-"));
execSync(`npx astro build --outDir ${out}`, { stdio: "ignore", env: { ...process.env, PUBLIC_KYP_COORDINATOR: COORD, PUBLIC_KYP_LOCK: LOCK } });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  let f = path.join(out, p);
  if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
  if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const N = (n) => (BigInt(Math.round(n * 1000)) * 10n ** 21n).toString();
const now = Math.floor(Date.now() / 1000);
const L = {
  id: 1, launcher: LAUNCHER, status: "Open", created_at: now - 3600, name: "Test Frog", symbol: "TFROG", icon: null, description: "fixture", terms_uri: null,
  token_id: `tfrog-1.${COORD}`, quote_token_id: "wrap.testnet", total_supply: (10n ** 27n).toString(), decimals: 18,
  opening_fdv_quote: N(2500), presale_cap_bps: 2000, min_raise: N(10), wallet_min: N(1), wallet_max: N(100), open_cap_quote: N(500),
  open_slots: 3, reserved_slots: 0, filled_open_slots: 1, filled_reserved_slots: 0, reserved_quote_total: "0",
  sale_start: now - 3600, sale_end: now + 86400, milestones: [{ target_fdv_quote: N(500000), unlock_bps: 10000 }],
  twap: { window_sec: 3600, min_observations: 6, min_liquidity: "1", claim_delay_sec: 3600, min_obs_interval_sec: 300 },
  reveal: { waves: 2, interval_sec: 86400 },
  fee_split: { holders_bps: 5000, liquidity_bps: 3000, community_bps: 2000, holders_account: "h.testnet", liquidity_account: "l.testnet", community_account: "c.testnet" },
  total_raised: N(20), presale_tokens: "0", reserved_tokens: "0", lp_tokens: "0", pool_contract: "dclv2.ref-dev.testnet", pool_id: "x", token_is_x: true, init_point: 0,
  progress: { lock_funded: false, pool_created: false, token_deposited: false, quote_deposited: false, liquidity_added: false },
  launched_at: null, revealed_waves: 0, next_wave_at: null, lpt_ids: [], fee_balances: [],
};
const views = {
  get_launches: () => [L], get_launch: (a) => (a.launch_id === 1 ? L : null), get_presalers: () => [],
  get_slot: () => ({ index: 0, kind: "Open", filled: false, deposit: "0", tokens: "0" }),
  get_config: () => ({ token_account_deposit: N(2.5), pool_storage_deposit: N(0.1), pool_create_deposit: N(0.1), liquidity_deposit: N(0.05) }),
  storage_balance_of: () => null, ft_balance_of: () => "0", storage_balance_bounds: () => ({ min: "1250000000000000000000", max: null }),
};

// Fake wallet, injected the standard NEAR Connect way. Records transactions instead of signing.
const MOCK_WALLET = () => {
  const manifest = {
    id: "kyp-test-wallet", name: "KYP Test Wallet", icon: "/favicon.svg", description: "e2e mock", website: "", version: "1", executor: "", type: "injected",
    platform: [], permissions: {},
    features: { signMessage: false, signTransaction: false, signAndSendTransaction: true, signAndSendTransactions: true, signInWithoutAddKey: true, signInAndSignMessage: false, signInWithFunctionCallKey: false, signDelegateActions: false, mainnet: false, testnet: true },
  };
  const acct = () => localStorage.getItem("kyp-test-account");
  const outcome = (t) => { (window.__txs ||= []).push(t); return { status: { SuccessValue: "" }, transaction: { hash: "MOCKHASH" + window.__txs.length }, receipts_outcome: [] }; };
  const wallet = {
    manifest,
    signIn: async () => { const a = localStorage.getItem("kyp-test-next") || "ana.testnet"; localStorage.setItem("kyp-test-account", a); return [{ accountId: a, publicKey: "ed25519:11111111111111111111111111111111" }]; },
    signOut: async () => localStorage.removeItem("kyp-test-account"),
    getAccounts: async () => (acct() ? [{ accountId: acct(), publicKey: "ed25519:11111111111111111111111111111111" }] : []),
    signAndSendTransaction: async (p) => outcome({ receiverId: p.receiverId, actions: p.actions }),
    signAndSendTransactions: async (p) => p.transactions.map((t) => outcome(t)),
  };
  window.addEventListener("near-selector-ready", () => window.dispatchEvent(new CustomEvent("near-wallet-injected", { detail: wallet })));
};

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addInitScript(MOCK_WALLET);
await ctx.route("**/rpc.testnet.near.org/**", async (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  const p = body.params;
  if (!p || p.request_type !== "call_function") return route.continue();
  const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
  const r = views[p.method_name]?.(args) ?? null;
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(r))], logs: [] } }) });
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const text = () => page.evaluate(() => document.body.innerText);
const txs = () => page.evaluate(() => window.__txs ?? []);
let passed = 0;
const step = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

try {
  await page.goto(`${base}/how-it-works`);
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("kyp-mode", "testnet"); });

  await step("connect button renders; modal lists testnet wallets", async () => {
    await page.goto(`${base}/launch?id=1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="wallet-connect"]');
    await page.waitForFunction(() => window.kypWallets, null, { timeout: 20000 });
    const ids = await page.evaluate(() => window.kypWallets.available().map((x) => x.split(":")[0]));
    for (const id of ["kyp-test-wallet", "ws-sender", "ws-here-wallet", "ws-bitget-wallet"]) assert.ok(ids.includes(id), `${id} missing from ${ids}`);
    if (ids.includes("meteor-wallet")) for (const id of ["mynearwallet", "intear-wallet", "ledger", "nightly-wallet"]) assert.ok(ids.includes(id), id);
    else console.log("    (NEAR Connect manifest not reachable; skipped manifest wallet checks)");
    assert.ok(!ids.includes("hot-wallet"), "HOT does not support testnet");
    assert.ok((await text()).includes("Connect a NEAR testnet wallet to launch"));
  });

  await step("connect as a non-launcher via the modal; launch controls hidden", async () => {
    await page.evaluate((a) => localStorage.setItem("kyp-test-next", a), PRESALER);
    await page.click('[data-testid="wallet-connect"]');
    await page.click("text=KYP Test Wallet");
    await page.waitForSelector('[data-testid="wallet-account"]');
    assert.equal((await page.textContent('[data-testid="wallet-account"]')).trim(), PRESALER);
    await page.waitForFunction(() => document.body.innerText.includes("Only the launcher"));
    assert.equal(await page.$('[data-testid="launch-sign"]'), null);
  });

  await step("session persists across reload", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="wallet-account"]', { timeout: 20000 });
  });

  await step("allowlisted wallet deposit = one wNEAR tx (storage + wrap + ft_transfer_call)", async () => {
    await page.goto(`${base}/deposit?id=1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="wallet-account"]', { timeout: 20000 });
    assert.ok((await text()).includes("Enter the invite code"));
    await page.fill('input[placeholder="from the launcher, sent privately"]', "code123");
    await page.click('[data-testid="deposit-sign"]');
    await page.waitForFunction(() => (window.__txs ?? []).length === 1);
    const [t] = await txs();
    assert.equal(t.receiverId, "wrap.testnet");
    const methods = t.actions.map((a) => a.params.methodName);
    assert.deepEqual(methods, ["storage_deposit", "storage_deposit", "near_deposit", "ft_transfer_call"]);
    const ftc = t.actions[3].params;
    assert.equal(ftc.args.receiver_id, COORD);
    assert.equal(ftc.args.amount, N(10));
    assert.equal(ftc.deposit, "1");
    assert.deepEqual(JSON.parse(ftc.args.msg), { Deposit: { launch_id: 1, salt: "code123" } });
  });

  await step("launcher sees launch; signs coordinator.launch with pool NEAR attached", async () => {
    await page.click('[data-testid="wallet-disconnect"]');
    await page.waitForSelector('[data-testid="wallet-connect"]');
    await page.evaluate((a) => localStorage.setItem("kyp-test-next", a), LAUNCHER);
    await page.goto(`${base}/launch?id=1`, { waitUntil: "networkidle" });
    await page.click('[data-testid="wallet-connect"]');
    await page.click("text=KYP Test Wallet");
    await page.waitForSelector('[data-testid="launch-sign"]');
    await page.click('[data-testid="launch-sign"]');
    await page.waitForFunction(() => (window.__txs ?? []).length === 1);
    const [t] = await txs();
    assert.equal(t.receiverId, COORD);
    assert.equal(t.actions[0].params.methodName, "launch");
    assert.equal(t.actions[0].params.deposit, N(0.3));
  });

  await step("no console errors", async () => assert.deepEqual(errors, []));
  console.log(`wallet e2e: ${passed} passed`);
} catch (e) {
  console.error(`wallet e2e FAILED after ${passed} steps:`, e.message);
  if (errors.length) console.error("console errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
