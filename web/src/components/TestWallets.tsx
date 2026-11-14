// TESTNET-ONLY test wallets page: generate faucet accounts in this browser, switch/export/import/
// delete them, wrap NEAR, and run a sample launch end to end ("Test mode" quick start).
import { createResource, createSignal, For, Show } from "solid-js";
import { CONFIG, NETWORK, TEST_WALLETS, INSTANCES, INSTANCE } from "../lib/config";
import { explorerTxUrl } from "../lib/network.mjs";
import { view } from "../lib/near";
import { account, walletName, connectTestWallet } from "../lib/wallet";
import { testWallets, activeTestWallet, generateTestWallet, generateTestWallets, walletsByBalance, testWalletRoom, MAX_TEST_WALLETS, type BatchProgress, importTestWallet, deleteTestWallet, exportTestWallet, setActiveTestWallet, sendWithTestWallet, testnetBalances, findTestWallet, type TestWallet } from "../lib/testwallet-ui";
import { quickStart, wrapTx, sampleAmount, MAX_PRESALERS } from "../lib/testflow.mjs";
import { fmtQ, toast } from "./ui";

const QS_KEY = "kyp-testmode";
const NEAR = 10n ** 24n;
const addr = (id: string) => `https://testnet.nearblocks.io/address/${id}`;
const nearStr = (y: string | null) => (y == null ? "—" : `${(Number(BigInt(y) / 10n ** 21n) / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 })} NEAR`);

interface LogLine { step: string; hash?: string | null; account?: string; error?: boolean }

function Balances(p: { id: string; tick: number }) {
  const [b] = createResource(() => [p.id, p.tick] as const, ([id]) => testnetBalances(id));
  return <span class="sub" data-testid="tw-balance">{b() ? `${nearStr(b()!.near)} · ${fmtQ(b()!.wnear)}` : "…"}</span>;
}

export default function TestWallets() {
  if (!TEST_WALLETS || NETWORK !== "testnet") {
    return <div class="card"><h2>Test wallets are off</h2><p class="sub">In-browser test wallets exist only on testnet builds. This site runs on {NETWORK}.</p></div>;
  }
  const [busy, setBusy] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0);
  const [label, setLabel] = createSignal("");
  const [count, setCount] = createSignal(1);
  const [reuse, setReuse] = createSignal(true);
  const [nPs, setNPs] = createSignal(Math.max(1, Math.min(MAX_PRESALERS, upgradeSaved().ps?.length || 2)));
  const [progress, setProgress] = createSignal<BatchProgress[]>([]);
  const [shown, setShown] = createSignal<{ id: string; text: string } | null>(null);
  const [impText, setImpText] = createSignal("");
  const [impId, setImpId] = createSignal("");
  const [log, setLog] = createSignal<LogLine[]>([]);
  const saved = () => { try { return JSON.parse(localStorage.getItem(QS_KEY) || "{}"); } catch { return {}; } };
  function upgradeSaved() { try { return upgrade(JSON.parse(localStorage.getItem(QS_KEY) || "{}")); } catch { return {}; } }
  function upgrade(v: any) { return v.a || v.b ? { launcher: v.launcher, ps: [v.a, v.b].filter(Boolean), salts: v.salts && !Array.isArray(v.salts) ? [v.salts.a, v.salts.b] : v.salts, launchId: v.launchId } : v; }
  const [qs, setQs] = createSignal<{ launcher?: string; ps?: string[]; salts?: string[]; launchId?: number }>(upgrade(saved()));
  const saveQs = (s: any) => { const v = { launcher: s.launcher?.accountId ?? s.launcher, ps: (s.ps ?? []).map((w: any) => w.accountId ?? w), salts: s.salts, launchId: s.launchId }; localStorage.setItem(QS_KEY, JSON.stringify(v)); setQs(v); };

  const run = async (name: string, fn: () => Promise<unknown>) => {
    if (busy()) return;
    setBusy(name);
    try { await fn(); } catch (e: any) {
      setLog((l) => [...l, { step: `${name} failed: ${e?.message ?? e}`, hash: e?.hash, error: true }]);
      toast(e?.message ?? String(e), "bad", 8000);
    } finally { setBusy(null); setTick((t) => t + 1); }
  };
  const push = (e: LogLine) => setLog((l) => [...l, e]);

  const ctx = {
    network: NETWORK, rpc: CONFIG.rpc, coordinator: CONFIG.coordinator, lock: CONFIG.lock, quote: CONFIG.quote,
    view: (c: string, m: string, a: any) => view<any>(c, m, a),
    send: (w: TestWallet, tx: any) => sendWithTestWallet(w, tx),
    generate: (l: string) => generateTestWallet(l),
    room: () => testWalletRoom(),
    get reuse() { return reuse() ? (exclude: string[]) => walletsByBalance(exclude) : undefined; },
    get presalers() { return nPs(); },
    now: () => Math.floor(Date.now() / 1000),
  };
  const flow = () => {
    const s = qs();
    const st: any = { salts: s.salts, launchId: s.launchId, launcher: s.launcher ? findTestWallet(s.launcher) ?? undefined : undefined, ps: (s.ps ?? []).map((id) => findTestWallet(id)).filter(Boolean) };
    if (st.launchId && (!st.launcher || st.ps.length !== (s.ps ?? []).length)) throw new Error("A test-mode wallet was deleted from this browser. Click Start over.");
    return quickStart(ctx, st, push);
  };
  const step = (name: string, k: "wallets" | "fund" | "create" | "deposit" | "launch" | "record" | "reveal" | "claim") => run(name, async () => {
    const f = flow();
    try { await (f.steps as any)[k](); } finally { saveQs(f.state); }
  });
  const runAll = () => run("quick start", async () => { const f = flow(); try { for (const k of ["wallets", "fund", "create", "deposit", "launch", "record"]) await (f.steps as any)[k](); } finally { saveQs(f.state); } toast("Sample launch is live", "ok"); });

  const wrap1 = (w: TestWallet) => run(`wrap ${w.accountId}`, async () => {
    const reg = await view<unknown>(CONFIG.quote, "storage_balance_of", { account_id: w.accountId }).catch(() => null);
    const r = await sendWithTestWallet(w, wrapTx({ quote: CONFIG.quote, signer: w.accountId, amount: NEAR.toString(), registered: reg != null }) as any);
    push({ step: "wrap 1 NEAR -> wNEAR", hash: r.hash, account: w.accountId });
  });
  const use = (w: TestWallet) => run(`use ${w.accountId}`, async () => { setActiveTestWallet(w.accountId); await connectTestWallet(); toast(`Signed in as ${w.accountId} (test wallet)`, "ok"); });

  return (
    <div class="stack" data-testid="test-wallets">
      <div class="notice warn" data-testid="tw-warning">
        <b>TESTNET ONLY — throwaway keys.</b> Test wallets are created by NEAR's free testnet faucet and their private keys are stored <b>unencrypted in this browser's localStorage</b>.
        Anyone using this browser profile can use them, and clearing site data deletes them unless you export them. Never send real (mainnet) NEAR to these accounts. Not available on mainnet builds.
      </div>

      <section class="card stack">
        <div class="card-title"><h2>Test mode quick start</h2><span class="pill">{INSTANCES.length ? INSTANCES.find((i) => i.id === INSTANCE)?.label : ""} · {CONFIG.coordinator}</span></div>
        <p class="sub">One click: generate a launcher and {nPs()} caballero wallet{nPs() > 1 ? "s" : ""} (10 testnet NEAR each from the faucet), wrap wNEAR, create a sample launch with every caballero allowlisted ({Math.min(3, nPs())} reveal wave{nPs() > 1 ? "s" : ""}), deposit sample amounts ({Array.from({ length: nPs() }, (_, i) => sampleAmount(i)).join(", ")} wNEAR), launch{CONFIG.pool.startsWith("dclv2") ? " (plus resume_launch steps for the RHEA DCL pool, 1000 Tgas each)" : ""}, and record 3 TWAP observations. Every step is signed in this browser and linked on nearblocks. Takes about a minute.</p>
        <div class="row" style={{ gap: "8px", "flex-wrap": "wrap" }}>
          <label class="sub inline-field">Caballeros <select data-testid="tw-presalers" value={nPs()} disabled={!!busy() || !!qs().launchId} onChange={(e) => setNPs(Number(e.currentTarget.value))}>
            {Array.from({ length: MAX_PRESALERS }, (_, i) => <option value={i + 1}>{i + 1}</option>)}
          </select> + launcher = {nPs() + 1} wallets</label>
          <label class="sub inline-field"><input type="checkbox" data-testid="tw-reuse" checked={reuse()} disabled={!!busy()} onChange={(e) => setReuse(e.currentTarget.checked)} /> reuse funded wallets I already have</label>
          <button class="btn primary" data-testid="tw-quickstart" disabled={!!busy()} onClick={runAll}>{busy() === "quick start" ? "Running…" : "Run quick start"}</button>
          <button class="btn sm" data-testid="tw-qs-wallets" disabled={!!busy()} onClick={() => step("generate test-mode wallets", "wallets")}>1 · Generate launcher + {nPs()} caballero{nPs() > 1 ? "s" : ""}</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("wrap", "fund")}>2 · Wrap wNEAR</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("create", "create")}>3 · Create sample launch</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("deposit", "deposit")}>4 · Deposit</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("launch", "launch")}>5 · Launch / resume</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("record", "record")}>6 · Record TWAP</button>
          <button class="btn sm" disabled={!!busy() || !qs().launchId} onClick={() => step("reveal", "reveal")}>Reveal next wave</button>
          <button class="btn sm" disabled={!!busy() || !qs().launchId} onClick={() => step("claim", "claim")}>Claim (caballero 1)</button>
          <button class="btn sm ghost" disabled={!!busy()} onClick={() => { localStorage.removeItem(QS_KEY); setQs({}); setLog([]); }}>Start over</button>
        </div>
        <Show when={qs().launcher}>
          <div class="kv sub" data-testid="tw-qs-state">
            <span>Launcher</span><span class="mono">{qs().launcher}</span>
            <For each={qs().ps ?? []}>{(id, i) => <><span>Caballero {i() + 1}</span><span class="mono">{id}{qs().salts?.[i()] ? ` · invite code ${qs().salts![i()]}` : ""}</span></>}</For>
            <Show when={qs().launchId}><span>Sample launch</span><span><a href={`/launch?id=${qs().launchId}`}>#{qs().launchId} status & chart</a> · <a href={`/deposit?id=${qs().launchId}`}>deposit</a> · <a href={`/claim?id=${qs().launchId}`}>claim</a> · <a href={`/reveal?id=${qs().launchId}`}>reveal</a></span></Show>
          </div>
        </Show>
        <Show when={log().length}>
          <ol class="sub mono" data-testid="tw-log" style={{ margin: 0, "padding-left": "18px", "max-height": "260px", overflow: "auto" }}>
            <For each={log()}>{(e) => <li style={{ color: e.error ? "#ff8a8a" : undefined }}>{e.step}{e.account ? ` · ${e.account}` : ""}{e.hash ? <> · <a href={explorerTxUrl(e.hash, "testnet")} target="_blank" rel="noopener" data-testid="tw-txlink">tx {e.hash.slice(0, 8)}…</a></> : ""}</li>}</For>
          </ol>
        </Show>
      </section>

      <section class="card stack">
        <div class="card-title"><h2>Your test wallets</h2><span class="pill" data-testid="tw-count">{testWallets().length} / {MAX_TEST_WALLETS} in this browser</span></div>
        <div class="row" style={{ gap: "8px", "flex-wrap": "wrap" }}>
          <input placeholder="label (optional)" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} style={{ width: "180px" }} />
          <label class="sub">How many <select data-testid="tw-gen-count" value={count()} disabled={!!busy()} onChange={(e) => setCount(Number(e.currentTarget.value))}>
            {Array.from({ length: MAX_TEST_WALLETS }, (_, i) => <option value={i + 1}>{i + 1}</option>)}
          </select></label>
          <button class="btn primary" data-testid="tw-generate" disabled={!!busy() || testWalletRoom() === 0} onClick={() => run("generate", async () => {
            const n = Math.min(count(), testWalletRoom());
            if (n <= 0) throw new Error(`This browser already holds the maximum of ${MAX_TEST_WALLETS} test wallets. Delete one to add another.`);
            setProgress([]);
            const r = await generateTestWallets(n, label() || "wallet", (p) => setProgress((xs) => { const out = xs.slice(); out[p.i] = p; return out; }));
            for (const w of r.created) push({ step: w.fundedBy ? `created test wallet (faucet rate-limited; 2 NEAR from ${w.fundedBy})` : "generated test wallet", account: w.accountId, hash: w.hash });
            for (const e of r.errors) push({ step: `wallet ${e.i + 1} not created: ${e.error}`, error: true });
            toast(`Created ${r.created.length} of ${n} test wallet${n > 1 ? "s" : ""}${r.errors.length ? ` · ${r.errors.length} failed (see below)` : " (10 testnet NEAR each)"}`, r.errors.length ? "bad" : "ok", 6000);
          })}>
            {busy() === "generate" ? `Creating ${progress().filter((p) => p?.status === "ok").length}/${progress()[0]?.total ?? count()}…` : `Generate ${count() > 1 ? `${Math.min(count(), testWalletRoom()) || count()} test wallets` : "test wallet"}`}
          </button>
          <span class="sub">Signed in: {account() ? `${account()} via ${walletName()}` : "none"}</span>
        </div>
        <p class="sub">Up to 10 test wallets per browser, created one at a time with a short pause. NEAR's faucet limits each IP (it can answer “retry in 12 hours” after a busy day); when it does, new wallets are funded with 2 NEAR from your richest test wallet instead, so keep one funded or import a funded testnet key.</p>
        <Show when={testWalletRoom() === 0}><div class="notice" data-testid="tw-cap">This browser holds the maximum of {MAX_TEST_WALLETS} test wallets. Delete one to generate or import another.</div></Show>
        <Show when={count() > testWalletRoom() && testWalletRoom() > 0}><div class="sub">Only {testWalletRoom()} slot{testWalletRoom() > 1 ? "s" : ""} free (max {MAX_TEST_WALLETS}); that many will be created.</div></Show>
        <Show when={progress().length}>
          <ol class="sub mono" data-testid="tw-progress" style={{ margin: 0, "padding-left": "18px" }}>
            <For each={progress()}>{(p) => <li style={{ color: p?.status === "error" ? "#ff8a8a" : undefined }}>{!p ? "waiting" : p.status === "ok" ? `✓ ${p.accountId}` : p.status === "creating" ? "creating…" : p.status === "retry" ? `retrying (${p.error})` : `✗ ${p.error}`}</li>}</For>
          </ol>
        </Show>
        <Show when={testWallets().length} fallback={<p class="sub">No test wallets yet. Generate one, or pick “Test wallet (testnet only)” in Connect wallet.</p>}>
          <table class="t" data-testid="tw-table">
            <thead><tr><th>Wallet</th><th>Balance</th><th></th></tr></thead>
            <tbody>
              <For each={testWallets()}>{(w) => (
                <tr data-testid="tw-row">
                  <td><div class="mono"><a href={addr(w.accountId)} target="_blank" rel="noopener">{w.accountId}</a></div><span class="sub">{w.label}{w.imported ? " · imported" : ""}{w.fundedBy ? ` · funded by ${w.fundedBy}` : ""}{activeTestWallet() === w.accountId ? " · active" : ""}{account() === w.accountId ? " · signed in" : ""}</span></td>
                  <td><Balances id={w.accountId} tick={tick()} /></td>
                  <td><div class="row" style={{ gap: "6px", "justify-content": "flex-end", "flex-wrap": "wrap" }}>
                    <button class="btn sm primary" data-testid="tw-use" disabled={!!busy() || account() === w.accountId} onClick={() => use(w)}>{account() === w.accountId ? "In use" : "Use"}</button>
                    <button class="btn sm" data-testid="tw-wrap" disabled={!!busy()} onClick={() => wrap1(w)}>Wrap 1 NEAR</button>
                    <button class="btn sm ghost" data-testid="tw-export" onClick={() => { if (shown()?.id === w.accountId) return setShown(null); if (confirm("Show this TESTNET private key? Anyone who sees it controls the account.")) setShown({ id: w.accountId, text: exportTestWallet(w.accountId) }); }}>{shown()?.id === w.accountId ? "Hide key" : "Export"}</button>
                    <button class="btn sm ghost" data-testid="tw-delete" onClick={() => { if (confirm(`Delete ${w.accountId} from this browser? Export the key first if you want to keep the account.`)) { deleteTestWallet(w.accountId); if (shown()?.id === w.accountId) setShown(null); } }}>Delete</button>
                  </div></td>
                </tr>
              )}</For>
            </tbody>
          </table>
        </Show>
        <Show when={shown()}>{(s) => (
          <div class="stack">
            <div class="notice warn">Testnet key for {s().id}. Keep it to yourself; never reuse it on mainnet. Works with near-cli (<code>~/.near-credentials/testnet/{s().id}.json</code>) or Import below.</div>
            <textarea class="mono" readonly rows={6} data-testid="tw-export-text" value={s().text} />
            <button class="btn sm" onClick={() => navigator.clipboard?.writeText(s().text).then(() => toast("Copied", "ok"))}>Copy</button>
          </div>
        )}</Show>
        <details>
          <summary class="sub" style={{ cursor: "pointer" }}>Import a testnet key</summary>
          <div class="stack" style={{ "margin-top": "8px" }}>
            <input placeholder="account id (if pasting a bare ed25519: key)" value={impId()} onInput={(e) => setImpId(e.currentTarget.value)} />
            <textarea rows={4} class="mono" placeholder='export JSON, near-cli credentials JSON, or ed25519:…' value={impText()} onInput={(e) => setImpText(e.currentTarget.value)} data-testid="tw-import-text" />
            <button class="btn sm" data-testid="tw-import" disabled={testWalletRoom() === 0} onClick={() => { try { const id = importTestWallet(impText(), impId()); setImpText(""); setImpId(""); toast(`Imported ${id}`, "ok"); } catch (e: any) { toast(e?.message ?? String(e), "bad"); } }}>Import</button>
          </div>
        </details>
      </section>
    </div>
  );
}
