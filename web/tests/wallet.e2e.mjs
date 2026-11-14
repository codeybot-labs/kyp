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
import { decodeSignedTransaction } from "@near-js/transactions";

const COORD = "kyp-coord.testnet", LOCK = "kyp-lock.testnet", LAUNCHER = "boss.testnet", PRESALER = "ana.testnet";
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
/** Build the site with `env` into a temp dir and serve it on a random port. */
function buildAndServe(env) {
  const out = mkdtempSync(path.join(tmpdir(), "kyp-e2e-"));
  execSync(`npx astro build --outDir ${out}`, { stdio: "ignore", env: { ...process.env, ...env } });
  const server = createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    let f = path.join(out, p);
    if (!existsSync(f) && existsSync(f + ".html")) f += ".html";
    if (!existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": types[path.extname(f)] ?? "application/octet-stream" });
    res.end(readFileSync(f));
  }).listen(0);
  return { server, base: `http://localhost:${server.address().port}` };
}
// blank the committed .env.production testnet IDs so the e2e builds use the mocked RPC + test IDs
const NO_NET = { PUBLIC_NEAR_NETWORK: "", PUBLIC_WALLETCONNECT_PROJECT_ID: "", PUBLIC_KYP_TESTNET_COORDINATOR: "", PUBLIC_KYP_TESTNET_LOCK: "", PUBLIC_KYP_TESTNET_POOL: "", PUBLIC_NEAR_TESTNET_RPC: "", PUBLIC_KYP_TESTNET_LABEL: "", PUBLIC_KYP_TESTNET_ALT_COORDINATOR: "", PUBLIC_KYP_TESTNET_ALT_LOCK: "", PUBLIC_KYP_TESTNET_ALT_POOL: "", PUBLIC_KYP_TESTNET_ALT_LABEL: "" };
const { server, base } = buildAndServe({ ...NO_NET, PUBLIC_KYP_COORDINATOR: COORD, PUBLIC_KYP_LOCK: LOCK });

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
// Live launches for the price chart: #2 has recorded observations, #3 has none (empty state).
const live = (id) => ({ ...L, id, status: "Live", launched_at: now - 7200, init_point: -39200, pool_id: `p${id}`, presale_tokens: "1", lp_tokens: "1",
  milestones: [{ target_fdv_quote: N(40), unlock_bps: 2500 }, { target_fdv_quote: N(2000), unlock_bps: 7500 }],
  progress: { lock_funded: true, pool_created: true, token_deposited: true, quote_deposited: true, liquidity_added: true } });
const LIVE = { 2: live(2), 3: live(3) };
const OBS = { 2: Array.from({ length: 12 }, (_, i) => ({ ts: now - 7200 + i * 600, point: -39200 + i * 900, liquidity: "1000" })), 3: [] };
const lockView = (id) => ({ launch_id: id, token_id: "t", pool_contract: "dclv2.ref-dev.testnet", pool_id: `p${id}`, token_is_x: true, milestones: LIVE[id].milestones.map((m) => ({ ...m, qualified_at: null, qualified_twap_point: null })),
  twap: L.twap, observations_count: OBS[id].length, last_observation: OBS[id].at(-1) ?? null, supply: L.total_supply, total_locked: "1", total_claimed: "0", positions_count: 1, created_at: now - 7200, unlocked_bps: 0 });
const views = {
  get_launches: () => [L], get_launch: (a) => (a.launch_id === 1 ? L : LIVE[a.launch_id] ?? null), get_presalers: () => [],
  get_lock: (a) => (LIVE[a.launch_id] ? lockView(a.launch_id) : null),
  get_observations: (a) => (OBS[a.launch_id] ?? []).slice(a.from_index ?? 0, (a.from_index ?? 0) + (a.limit ?? 200)),
  twap_status: () => ({ ok: false, error: "fixture", avg_point: null, twap_fdv_quote: null, observations_in_window: null, spot_point: null, spot_fdv_quote: null }),
  get_pool: (a) => (a.pool_id === "p2" ? { pool_id: "p2", current_point: -28000, liquidity: "1000", state: "Running" } : null),
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
  const ok = (result) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result }) });
  // Direct-signing RPCs used by the in-browser test wallet (nothing reaches a real chain).
  if (body.method === "block") return ok({ header: { hash: "11111111111111111111111111111111", height: 100, timestamp: 0 } });
  if (body.method === "send_tx" || body.method === "broadcast_tx_commit") {
    const st = decodeSignedTransaction(Buffer.from(p.signed_tx_base64 ?? p[0], "base64"));
    const t = st.transaction;
    const hash = `TW${signed.length + 1}HASH`;
    signed.push({ signer: t.signerId, receiver: t.receiverId, nonce: Number(t.nonce), methods: t.actions.map((a) => a.functionCall?.methodName), args: t.actions.map((a) => a.functionCall && JSON.parse(Buffer.from(a.functionCall.args).toString() || "{}")), deposits: t.actions.map((a) => String(a.functionCall?.deposit)), gas: t.actions.map((a) => String(a.functionCall?.gas)) });
    return ok({ final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" }, transaction: { hash, signer_id: t.signerId, receiver_id: t.receiverId }, transaction_outcome: { id: hash, outcome: { status: { SuccessValue: "" }, logs: [], receipt_ids: [], gas_burnt: 1, tokens_burnt: "0", executor_id: t.signerId } }, receipts_outcome: [] });
  }
  if (p?.request_type === "view_access_key") return ok({ nonce: 5, permission: "FullAccess", block_hash: "11111111111111111111111111111111", block_height: 100 });
  if (p?.request_type === "view_account") return ok({ amount: "10000000000000000000000000", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 182, block_height: 100, block_hash: "11111111111111111111111111111111" });
  if (!p || p.request_type !== "call_function") return route.continue();
  const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString());
  const r = views[p.method_name]?.(args) ?? null;
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result: [...Buffer.from(JSON.stringify(r))], logs: [] } }) });
});
// The free testnet faucet helper, mocked: records the request instead of creating an account.
const faucet = [], signed = [];
let faucetFail = 0, faucetLimited = false; // next N calls answer 503 (transient) / every call answers the real 429 text
await ctx.route("**/helper.nearprotocol.com/**", async (route) => {
  if (faucetLimited) return route.fulfill({ status: 429, headers: { "access-control-allow-origin": "*" }, body: "Rate limit exceeded, retry in 12 hours." });
  if (faucetFail > 0) { faucetFail--; return route.fulfill({ status: 503, headers: { "access-control-allow-origin": "*" }, body: "busy" }); }
  faucet.push({ url: route.request().url(), body: JSON.parse(route.request().postData() || "{}") });
  await route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ final_execution_status: "EXECUTED_OPTIMISTIC", status: { SuccessValue: "" } }) });
});
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const text = () => page.evaluate(() => document.body.innerText);
const txs = () => page.evaluate(() => window.__txs ?? []);
let passed = 0;
let manifestReachable = false;
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
    for (const id of ["ws-safepal-wallet", "ws-near-mobile-wallet"]) assert.ok(ids.includes(id), `${id} missing`);
    manifestReachable = ids.includes("meteor-wallet");
    if (manifestReachable) {
      for (const id of ["mynearwallet", "intear-wallet", "ledger", "nightly-wallet"]) assert.ok(ids.includes(id), id);
      // Mainnet-only wallets are listed on testnet, labelled.
      const w = await page.evaluate(() => ({ list: window.kypWallets.available(), mainnetOnly: window.kypWallets.mainnetOnly(), network: window.kypWallets.network }));
      assert.equal(w.network, "testnet");
      for (const id of ["hot-wallet", "okx-wallet", "hana-wallet", "trezu-wallet"]) {
        assert.ok(w.mainnetOnly.includes(id), `${id} not flagged mainnet-only`);
        const entry = w.list.find((x) => x.startsWith(`${id}:`));
        assert.ok(entry?.endsWith("(mainnet only)"), `${id} not labelled: ${entry}`);
      }
      assert.ok(!w.list.find((x) => x.startsWith("mynearwallet:")).includes("mainnet only"), "MyNearWallet works on testnet");
      assert.ok(!ids.includes("near-mobile"), "NEAR Mobile listed once");
    } else console.log("    (NEAR Connect manifest not reachable; skipped manifest wallet checks)");
    assert.ok(!ids.includes("wallet-connect") && !ids.includes("unity-wallet"), "WalletConnect wallets hidden without a project ID");
    assert.ok((await text()).includes("Connect a NEAR testnet wallet to launch"));
  });

  await step("testnet: clicking a mainnet-only wallet explains instead of connecting", async () => {
    if (!manifestReachable) return console.log("    (skipped: manifest not reachable)");
    await page.click('[data-testid="wallet-connect"]');
    await page.click("text=HOT Wallet (mainnet only)");
    await page.waitForSelector('[data-testid="toast"]');
    const t = await page.textContent('[data-testid="toast"]');
    assert.match(t, /HOT Wallet only works on NEAR mainnet/);
    assert.equal(await page.$('[data-testid="wallet-account"]'), null);
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
    assert.equal(ftc.args.amount, N(100), "amount defaults to the per-wallet max (100), not more");
    assert.equal(ftc.deposit, "1");
    assert.deepEqual(JSON.parse(ftc.args.msg), { Deposit: { launch_id: 1, salt: "code123" } });
  });

  await step("launcher sees launch; signs coordinator.launch with pool NEAR attached", async () => {
    await page.click('[data-testid="wallet-account"]');
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

  await step("price chart: lazy chunk, candles + line toggle, milestone lines, empty state, attribution", async () => {
    const chartJs = [];
    page.on("request", (r) => /lightweight-charts|PriceChart/.test(r.url()) && chartJs.push(r.url()));
    await page.goto(`${base}/deposit?id=1`, { waitUntil: "networkidle" });
    assert.deepEqual(chartJs, [], "chart code is not loaded on other pages");
    await page.goto(`${base}/launch?id=2`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="price-chart"] canvas', { timeout: 20000 });
    assert.ok(chartJs.some((u) => /lightweight-charts/.test(u)), "lightweight-charts loaded lazily on the status page");
    const t = await page.textContent('[data-testid="price-chart"]');
    assert.match(t, /13 points/, "12 observations + live pool point");
    assert.match(t, /on-chain · lock observations \+ live pool/);
    assert.ok(await page.$('[data-testid="price-chart"] a[href="https://www.tradingview.com/"]'), "TradingView attribution link");
    assert.ok(await page.$('#tv-attr-logo, a[href*="tradingview.com"][id], a[href*="tradingview"]'), "attribution logo/link");
    await page.waitForSelector('[data-testid="price-chart"][data-milestone-lines="2"][data-kind="candles"]');
    await page.click('[data-testid="chart-kind-line"]');
    await page.waitForSelector('[data-testid="price-chart"][data-milestone-lines="2"][data-kind="line"]');
    await page.click('[data-testid="chart-unit-price"]');
    assert.match(await page.textContent('[data-testid="price-chart"]'), /Price per token in wNEAR/);
    await page.click('[data-testid="chart-kind-candles"]');
    await page.goto(`${base}/launch?id=3`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="chart-empty"]', { timeout: 20000 });
    assert.match(await page.textContent('[data-testid="chart-empty"]'), /Not enough price data yet/);
  });

  await step("test wallet: generate (faucet) -> wrap -> deposit signed in-browser, export/import/delete", async () => {
    await page.goto(`${base}/test-wallets`, { waitUntil: "networkidle" });
    assert.match(await page.textContent('[data-testid="tw-warning"]'), /TESTNET ONLY/);
    assert.ok((await text()).includes("Test wallets"), "nav link on testnet");
    await page.fill('input[placeholder="label (optional)"]', "e2e");
    await page.click('[data-testid="tw-generate"]');
    await page.waitForSelector('[data-testid="tw-row"]', { timeout: 20000 });
    assert.equal(faucet.length, 1);
    const id = faucet[0].body.newAccountId;
    assert.match(id, /^kyp-t-e2e-[a-z0-9]{8}\.testnet$/);
    assert.match(faucet[0].body.newAccountPublicKey, /^ed25519:/);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("kyp-testnet-wallets")));
    assert.equal(stored[0].accountId, id);
    assert.ok(!JSON.stringify(faucet).includes(stored[0].secretKey.slice(8)), "secret key never sent to the faucet");
    assert.ok(!(await text()).includes(stored[0].secretKey), "key not shown until export");

    await page.click('[data-testid="tw-wrap"]');
    await page.waitForSelector('[data-testid="tw-txlink"]', { timeout: 20000 });
    assert.equal(signed.length, 1);
    assert.deepEqual([signed[0].signer, signed[0].receiver, signed[0].methods.join("+")], [id, "wrap.testnet", "storage_deposit+near_deposit"]);
    assert.ok(signed[0].nonce > 5, "nonce from the access key");
    assert.equal(signed[0].deposits[1], N(1));
    assert.equal(await page.getAttribute('[data-testid="tw-txlink"]', "href"), "https://testnet.nearblocks.io/txns/TW1HASH");

    // The test wallet in the standard picker: connect, then the normal deposit page signs through it.
    await page.click('[data-testid="wallet-account"]').catch(() => {});
    await page.click('[data-testid="tw-use"]');
    await page.waitForFunction((a) => document.querySelector('[data-testid="wallet-account"]')?.getAttribute("title")?.startsWith(a), id, { timeout: 20000 });
    const ids = await page.evaluate(() => window.kypWallets.available().map((x) => x.split(":")[0]));
    assert.equal(ids[0], "kyp-testnet-wallet", "test wallet listed first in the picker");
    await page.goto(`${base}/deposit?id=1`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="wallet-account"]', { timeout: 20000 });
    await page.fill('input[placeholder="from the launcher, sent privately"]', "code-tw");
    await page.click('[data-testid="deposit-sign"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="toast"]')?.textContent?.includes("tx"), null, { timeout: 20000 });
    assert.equal(signed.length, 2);
    assert.deepEqual([signed[1].signer, signed[1].receiver, signed[1].methods.at(-1)], [id, "wrap.testnet", "ft_transfer_call"]);
    assert.deepEqual(JSON.parse(signed[1].args.at(-1).msg), { Deposit: { launch_id: 1, salt: "code-tw" } });

    // export -> delete -> import round trip
    await page.goto(`${base}/test-wallets`, { waitUntil: "networkidle" });
    await page.click('[data-testid="tw-export"]');
    const exp = await page.inputValue('[data-testid="tw-export-text"]');
    assert.match(exp, /TESTNET ONLY/);
    await page.click('[data-testid="tw-delete"]');
    await page.waitForFunction(() => !document.querySelector('[data-testid="tw-row"]'));
    await page.click("text=Import a testnet key");
    await page.fill('[data-testid="tw-import-text"]', exp);
    await page.click('[data-testid="tw-import"]');
    await page.waitForSelector('[data-testid="tw-row"]');
    assert.ok((await page.textContent('[data-testid="tw-row"]')).includes(id));
    await page.click('[data-testid="wallet-account"]').catch(() => {});
  });

  await step("test wallets: batch of 3 with per-wallet progress + a 503 retried, 429 falls back to funding from a test wallet, 10-wallet cap blocks generate/import, caballeros 1-9", async () => {
    await page.goto(`${base}/test-wallets`, { waitUntil: "networkidle" });
    const before = (await page.$$('[data-testid="tw-row"]')).length;
    const opts = await page.$$eval('[data-testid="tw-gen-count"] option', (o) => o.map((x) => x.value));
    assert.deepEqual(opts, ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    await page.selectOption('[data-testid="tw-gen-count"]', "3");
    await page.fill('input[placeholder="label (optional)"]', "batch");
    const f0 = faucet.length;
    faucetFail = 1; // first call of the batch fails transiently, then succeeds on retry
    await page.click('[data-testid="tw-generate"]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="tw-row"]').length === n, before + 3, { timeout: 40000 });
    await page.waitForFunction(() => !/Creating/.test(document.querySelector('[data-testid="tw-generate"]').textContent), null, { timeout: 20000 });
    const prog = await page.$$eval('[data-testid="tw-progress"] li', (ls) => ls.map((l) => l.textContent));
    assert.equal(prog.length, 3);
    assert.ok(prog.every((x) => x.startsWith("✓ kyp-t-batch-")), prog.join(" | "));
    assert.deepEqual(faucet.slice(f0).map((f) => f.body.newAccountId.replace(/-[a-z0-9]{8}\.testnet$/, "")), ["kyp-t-batch-1", "kyp-t-batch-2", "kyp-t-batch-3"]);
    assert.match(await page.textContent('[data-testid="tw-count"]'), new RegExp(`${before + 3} / 10`));
    // faucet rate limit -> the richest stored test wallet funds the new one through the testnet registrar
    faucetLimited = true;
    const s0 = signed.length;
    await page.selectOption('[data-testid="tw-gen-count"]', "1");
    await page.fill('input[placeholder="label (optional)"]', "fb");
    await page.click('[data-testid="tw-generate"]');
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="tw-row"]').length === n, before + 4, { timeout: 40000 });
    faucetLimited = false;
    assert.equal(signed.length, s0 + 1);
    const cr = signed.at(-1);
    assert.deepEqual([cr.receiver, cr.methods[0], cr.deposits[0]], ["testnet", "create_account", N(2)]);
    assert.match(cr.args[0].new_account_id, /^kyp-t-fb-[a-z0-9]{8}\.testnet$/);
    assert.ok((await text()).includes("funded by"), "row shows the funder");
    // fill to the cap (fake keys are fine: nothing is signed) and check generate + import are blocked
    await page.evaluate(() => {
      const l = JSON.parse(localStorage.getItem("kyp-testnet-wallets"));
      for (let i = l.length; i < 10; i++) l.push({ accountId: `kyp-t-fill-${i}.testnet`, secretKey: "ed25519:" + "3".repeat(88), label: "fill", createdAt: 1 });
      localStorage.setItem("kyp-testnet-wallets", JSON.stringify(l));
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="tw-cap"]');
    assert.match(await page.textContent('[data-testid="tw-cap"]'), /maximum of 10/);
    assert.ok(await page.isDisabled('[data-testid="tw-generate"]'));
    assert.ok(await page.isDisabled('[data-testid="tw-import"]'));
    const f1 = faucet.length;
    await page.evaluate(() => document.querySelector('[data-testid="tw-generate"]').click());
    await page.waitForTimeout(500);
    assert.equal(faucet.length, f1, "no faucet call at the cap");
    const ps = await page.$$eval('[data-testid="tw-presalers"] option', (o) => o.map((x) => x.value));
    assert.deepEqual(ps, ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
    await page.selectOption('[data-testid="tw-presalers"]', "9");
    assert.match(await page.textContent('[data-testid="test-wallets"]'), /\+ launcher = 10 wallets/);
    await page.evaluate(() => { localStorage.removeItem("kyp-testnet-wallets"); localStorage.removeItem("kyp-testnet-wallet-active"); });
  });

  await step("no console errors", async () => assert.deepEqual(errors.filter((e) => !/status of (429|503)/.test(e)), [])); // the 429/503 are the deliberate faucet failures above

  await step("mainnet build: same wallets work normally (no labels), mainnet RPC/labels, no testnet contracts", async () => {
    const m = buildAndServe({ ...NO_NET, PUBLIC_NEAR_NETWORK: "mainnet", PUBLIC_KYP_COORDINATOR: COORD, PUBLIC_KYP_LOCK: LOCK });
    try {
      const p = await ctx.newPage();
      const testnetCalls = [];
      p.on("request", (r) => /rpc\.testnet|testnet\.mynearwallet/.test(r.url()) && testnetCalls.push(r.url()));
      await p.goto(`${m.base}/`, { waitUntil: "networkidle" });
      await p.waitForFunction(() => window.kypWallets, null, { timeout: 20000 });
      const w = await p.evaluate(() => ({ list: window.kypWallets.available(), mainnetOnly: window.kypWallets.mainnetOnly(), network: window.kypWallets.network }));
      assert.equal(w.network, "mainnet");
      assert.deepEqual(w.mainnetOnly, []);
      assert.ok(w.list.every((x) => !x.includes("mainnet only")), "no labels on mainnet");
      const ids = w.list.map((x) => x.split(":")[0]);
      if (manifestReachable) for (const id of ["hot-wallet", "okx-wallet", "hana-wallet", "trezu-wallet", "near-mobile", "mynearwallet"]) assert.ok(ids.includes(id), `${id} missing on mainnet`);
      assert.ok(!ids.includes("ws-near-mobile-wallet"), "NEAR Mobile listed once on mainnet");
      const body = await p.evaluate(() => document.body.innerText);
      assert.ok(body.includes("NEAR mainnet"), "mainnet label shown");
      assert.ok(body.includes("Simulated preview"), "testnet contract IDs are ignored on mainnet -> simulated preview, clearly labelled");
      assert.deepEqual(testnetCalls, []);
      assert.ok(!ids.includes("kyp-testnet-wallet"), "no test wallet in the mainnet picker");
      assert.ok(!body.includes("Test wallets"), "no test wallet nav on mainnet");
      await p.goto(`${m.base}/test-wallets`, { waitUntil: "networkidle" });
      assert.ok((await p.evaluate(() => document.body.innerText)).includes("Test wallets are off"));
      await p.close();
    } finally { m.server.close(); }
  });

  await step("WalletConnect + Unity appear when PUBLIC_WALLETCONNECT_PROJECT_ID is set", async () => {
    if (!manifestReachable) return console.log("    (skipped: manifest not reachable)");
    const m = buildAndServe({ ...NO_NET, PUBLIC_WALLETCONNECT_PROJECT_ID: "e2e-placeholder-not-a-real-id" });
    try {
      const c2 = await browser.newContext();
      // Never talk to the real WalletConnect relay from tests.
      await c2.route(/walletconnect|reown/, (r) => r.abort());
      await c2.routeWebSocket(/walletconnect|reown/, (ws) => ws.close());
      const p = await c2.newPage();
      await p.goto(`${m.base}/`, { waitUntil: "networkidle" });
      await p.waitForFunction(() => window.kypWallets, null, { timeout: 20000 });
      const ids = await p.evaluate(() => window.kypWallets.available().map((x) => x.split(":")[0]));
      for (const id of ["wallet-connect", "unity-wallet"]) assert.ok(ids.includes(id), `${id} missing with project ID`);
      await c2.close();
    } finally { m.server.close(); }
  });
  console.log(`wallet e2e: ${passed} passed`);
} catch (e) {
  console.error(`wallet e2e FAILED after ${passed} steps:`, e.message);
  if (errors.length) console.error("console errors:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
