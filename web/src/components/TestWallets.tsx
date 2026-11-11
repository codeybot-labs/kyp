// TESTNET-ONLY test wallets page: generate faucet accounts in this browser, switch/export/import/
// delete them, wrap NEAR, and run a sample launch end to end ("Test mode" quick start).
import { createResource, createSignal, For, Show } from "solid-js";
import { CONFIG, NETWORK, TEST_WALLETS, INSTANCES, INSTANCE } from "../lib/config";
import { explorerTxUrl } from "../lib/network.mjs";
import { view } from "../lib/near";
import { account, walletName, connectTestWallet } from "../lib/wallet";
import { testWallets, activeTestWallet, generateTestWallet, importTestWallet, deleteTestWallet, exportTestWallet, setActiveTestWallet, sendWithTestWallet, testnetBalances, findTestWallet, type TestWallet } from "../lib/testwallet-ui";
import { quickStart, wrapTx } from "../lib/testflow.mjs";
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
  const [shown, setShown] = createSignal<{ id: string; text: string } | null>(null);
  const [impText, setImpText] = createSignal("");
  const [impId, setImpId] = createSignal("");
  const [log, setLog] = createSignal<LogLine[]>([]);
  const saved = () => { try { return JSON.parse(localStorage.getItem(QS_KEY) || "{}"); } catch { return {}; } };
  const [qs, setQs] = createSignal<{ launcher?: string; a?: string; b?: string; salts?: { a: string; b: string }; launchId?: number }>(saved());
  const saveQs = (s: any) => { const v = { launcher: s.launcher?.accountId ?? s.launcher, a: s.a?.accountId ?? s.a, b: s.b?.accountId ?? s.b, salts: s.salts, launchId: s.launchId }; localStorage.setItem(QS_KEY, JSON.stringify(v)); setQs(v); };

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
    now: () => Math.floor(Date.now() / 1000),
  };
  const flow = () => {
    const s = qs();
    const st: any = { salts: s.salts, launchId: s.launchId };
    for (const k of ["launcher", "a", "b"] as const) { const id = (s as any)[k]; if (id) { const w = findTestWallet(id); if (w) st[k] = w; } }
    return quickStart(ctx, st, push);
  };
  const step = (name: string, k: "wallets" | "fund" | "create" | "deposit" | "launch" | "record" | "reveal" | "claim") => run(name, async () => {
    const f = flow();
    if (k !== "wallets" && (!f.state.launcher || !f.state.a || !f.state.b)) throw new Error("Generate the 3 test-mode wallets first");
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
        <p class="sub">One click: generate a launcher and two presaler wallets (10 testnet NEAR each from the faucet), wrap wNEAR, create a sample launch with both presalers allowlisted, deposit 1 and 1.5 wNEAR, launch{CONFIG.pool.startsWith("dclv2") ? " (plus resume_launch steps for the RHEA DCL pool, 1000 Tgas each)" : ""}, and record 3 TWAP observations. Every step is signed in this browser and linked on nearblocks. Takes about a minute.</p>
        <div class="row" style={{ gap: "8px", "flex-wrap": "wrap" }}>
          <button class="btn primary" data-testid="tw-quickstart" disabled={!!busy()} onClick={runAll}>{busy() === "quick start" ? "Running…" : "Run quick start"}</button>
          <button class="btn sm" data-testid="tw-qs-wallets" disabled={!!busy()} onClick={() => step("generate launcher + 2 presalers", "wallets")}>1 · Generate launcher + 2 presalers</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("wrap", "fund")}>2 · Wrap wNEAR</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("create", "create")}>3 · Create sample launch</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("deposit", "deposit")}>4 · Deposit</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("launch", "launch")}>5 · Launch / resume</button>
          <button class="btn sm" disabled={!!busy()} onClick={() => step("record", "record")}>6 · Record TWAP</button>
          <button class="btn sm" disabled={!!busy() || !qs().launchId} onClick={() => step("reveal", "reveal")}>Reveal next wave</button>
          <button class="btn sm" disabled={!!busy() || !qs().launchId} onClick={() => step("claim", "claim")}>Claim (presaler A)</button>
          <button class="btn sm ghost" disabled={!!busy()} onClick={() => { localStorage.removeItem(QS_KEY); setQs({}); setLog([]); }}>Start over</button>
        </div>
        <Show when={qs().launcher}>
          <div class="kv sub" data-testid="tw-qs-state">
            <span>Launcher</span><span class="mono">{qs().launcher}</span>
            <span>Presaler A</span><span class="mono">{qs().a}{qs().salts ? ` · invite code ${qs().salts!.a}` : ""}</span>
            <span>Presaler B</span><span class="mono">{qs().b}{qs().salts ? ` · invite code ${qs().salts!.b}` : ""}</span>
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
        <div class="card-title"><h2>Your test wallets</h2><span class="pill">{testWallets().length} in this browser</span></div>
        <div class="row" style={{ gap: "8px", "flex-wrap": "wrap" }}>
          <input placeholder="label (optional)" value={label()} onInput={(e) => setLabel(e.currentTarget.value)} style={{ width: "180px" }} />
          <button class="btn primary" data-testid="tw-generate" disabled={!!busy()} onClick={() => run("generate", async () => { const w = await generateTestWallet(label() || "wallet"); push({ step: "generated test wallet", account: w.accountId }); toast(`Created ${w.accountId} (10 testnet NEAR)`, "ok"); })}>
            {busy() === "generate" ? "Creating account…" : "Generate test wallet"}
          </button>
          <span class="sub">Signed in: {account() ? `${account()} via ${walletName()}` : "none"}</span>
        </div>
        <Show when={testWallets().length} fallback={<p class="sub">No test wallets yet. Generate one, or pick “Test wallet (testnet only)” in Connect wallet.</p>}>
          <table class="t" data-testid="tw-table">
            <thead><tr><th>Wallet</th><th>Balance</th><th></th></tr></thead>
            <tbody>
              <For each={testWallets()}>{(w) => (
                <tr data-testid="tw-row">
                  <td><div class="mono"><a href={addr(w.accountId)} target="_blank" rel="noopener">{w.accountId}</a></div><span class="sub">{w.label}{w.imported ? " · imported" : ""}{activeTestWallet() === w.accountId ? " · active" : ""}{account() === w.accountId ? " · signed in" : ""}</span></td>
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
            <button class="btn sm" data-testid="tw-import" onClick={() => { try { const id = importTestWallet(impText(), impId()); setImpText(""); setImpId(""); toast(`Imported ${id}`, "ok"); } catch (e: any) { toast(e?.message ?? String(e), "bad"); } }}>Import</button>
          </div>
        </details>
      </section>
    </div>
  );
}
