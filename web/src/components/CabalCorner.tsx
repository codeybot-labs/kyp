// Cabal Corner: where a launch's caballeros plan the launch together.
// On-chain (KYP contracts): launch data, launcher, revealed presalers + waves, lock positions.
// Synced (site Worker + Cloudflare D1) or local (this browser): roster skills, missions, bounties,
// competitions, votes and the activity log. See lib/corner-store.ts for which one is active.
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { api } from "../lib/source";
import { CONFIG, NETWORK_NAME } from "../lib/config";
import { account as wallet } from "../lib/wallet";
import { WithLaunch, useLive, fmtQ, TokenBadge, StatusPill, connectWallet, toast, tok } from "./ui";
import { SKILLS, skillById, cleanSkills, teamMix, missionsFor, bountyStatus, majority, approvalsNeeded, activity, agentAnswer, dayKey, isAlias } from "../lib/corner.mjs";
import * as store from "../lib/corner-store";
import { KB } from "../lib/corner-kb.mjs";
import type { LaunchView, PresalerView } from "../lib/model";

const FEATURES: [string, string][] = [
  ["Every caballero brings something.", "Each one has a different mix of skills, knowledge and experience, and puts it to work for the project."],
  ["One space, every skill.", "Devs, creators, designers and community builders work on the launch together."],
  ["The right team mix.", "The roster shows everyone's skills at a glance and flags gaps before launch."],
  ["Clear daily missions.", "A few tasks a day for each caballero, matched to their skills."],
  ["Your own AI agent.", "Answers from a curated library of NEAR ecosystem notes plus this launch's live data."],
  ["Bounties and competitions.", "Caballeros propose what will help most, agree it by majority vote, and size it against the fee pool's community share."],
  ["No passengers.", "Every mission, vote and delivery counts. Three quiet days flags a passenger."],
  ["Built in the open.", "Hidden presalers work under an alias; their wallet is tagged on their work when their wave is revealed on-chain."],
  ["Your record travels.", "Every launch adds to your KYP record, and that record decides who gets the next invite."],
];

const short = (a: string) => (a.length > 24 ? `${a.slice(0, 11)}…${a.slice(-9)}` : a);
const display = (id: string | null | undefined) => (!id ? "—" : id.startsWith("guest:") ? id.slice(6) : short(id));
const ago = (ts: number) => {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};

function SkillChips(p: { skills: string[] }) {
  return (
    <span class="cc-chips">
      <For each={p.skills} fallback={<span class="sub">no skills yet</span>}>
        {(s) => <span class={`cc-skill sm k-${s}`}>{skillById(s)?.emoji} {skillById(s)?.label}</span>}
      </For>
    </span>
  );
}

function Who(p: { id: string | null; reveals: Record<string, number>; launcher: string; me: string | null }) {
  return (
    <span class="cc-who">
      <span class={isAlias(p.id) ? "" : "mono"}>{display(p.id)}</span>
      <Show when={p.id && p.reveals[p.id] != null}><span class="cc-tag ok" title="Revealed presaler (coordinator get_presalers)">revealed · wave {p.reveals[p.id!]}</span></Show>
      <Show when={isAlias(p.id)}><span class="cc-tag dim" title="A presaler whose wave isn't revealed yet">hidden until reveal</span></Show>
      <Show when={p.id === p.launcher}><span class="cc-tag">launcher</span></Show>
      <Show when={p.id?.startsWith("guest:")}><span class="cc-tag dim">guest</span></Show>
      <Show when={p.id?.startsWith("sample-")}><span class="cc-tag dim">sample</span></Show>
      <Show when={p.id && p.id === p.me}><span class="cc-tag me">you</span></Show>
    </span>
  );
}

function Corner(p: { l: LaunchView }) {
  const l = () => p.l;
  const [mode] = createResource(store.storeMode);
  const [view, setView] = createSignal<store.CornerView | null>(null);
  const [loadErr, setLoadErr] = createSignal<string | null>(null);
  const [tick, setTick] = createSignal(0);
  const synced = () => mode() === "synced";

  let seq = 0;
  const load = async () => {
    if (!mode()) return;
    const mine = ++seq; // fast wallet switching: only the newest response may update the view
    try {
      let v: store.CornerView;
      if (!synced()) v = store.localGet(l().id);
      else {
        try { v = await store.remoteGet(l().id); }
        catch { await new Promise((r) => setTimeout(r, 800)); if (mine !== seq) return; v = await store.remoteGet(l().id); } // one quiet retry
      }
      if (mine === seq) { setView(v); setLoadErr(null); }
    } catch (e: any) { if (mine !== seq) return; setLoadErr(e?.message ?? String(e)); if (!view()) setView(store.localGet(l().id)); }
  };
  createResource(() => [mode(), wallet(), store.session()?.token, tick()] as const, load);
  const iv = setInterval(() => synced() && setTick((t) => t + 1), 20000);
  onCleanup(() => clearInterval(iv));

  const act = async (action: any, ok?: string) => {
    try {
      setView(synced() ? await store.remoteAct(l().id, action) : store.localAct(l().id, action));
      if (ok) toast(ok, "ok");
      return true;
    } catch (e: any) { toast(e?.message ?? String(e), "bad"); return false; }
  };

  const [ps] = useLive(() => api.presalers(p.l.id), 30000);
  const reveals = createMemo<Record<string, number>>(() => ({ ...(view()?.reveals ?? {}), ...Object.fromEntries((ps() ?? []).filter((x: PresalerView) => x.account_id).map((x) => [x.account_id!, x.wave])) }));
  const hiddenSlots = () => (ps() ?? []).filter((x) => !x.account_id).length;
  const st = () => view()?.state ?? { members: [], bounties: [], events: [], done: {} };
  const me = () => (synced() ? view()?.viewer ?? null : store.localViewer());
  const mine = () => st().members.find((m: any) => m.id === me());
  const mySkills = () => cleanSkills(mine()?.skills ?? []);
  const now = () => (tick(), Date.now());
  const roster = createMemo(() => st().members.map((m: any) => ({ ...m, act: activity(st(), m.id, now()) })));
  const mix = createMemo(() => teamMix(roster()));
  const passengers = () => roster().filter((r: any) => r.act.status === "passenger").map((r: any) => display(r.id));

  const today = dayKey();
  const missions = () => (me() ? missionsFor({ account: me()!, skills: mySkills(), symbol: l().symbol, day: today }) : []);
  const isDone = (mid: string) => (st().done[me() ?? ""] ?? []).includes(mid);

  const W = (x: Omit<Parameters<typeof Who>[0], "reveals" | "launcher" | "me">) => <Who {...x} reveals={reveals()} launcher={l().launcher} me={me()} />;

  return (
    <div class="stack cc">
      <div class={`notice ${synced() ? "" : "warn"}`} data-testid="corner-preview">
        <b>Early preview · {NETWORK_NAME}.</b>{" "}
        <Switch>
          <Match when={!mode()}>Checking storage…</Match>
          <Match when={synced()}>Launch data, reveals and records are read from the KYP contracts. Roster, missions and bounties are <b>synced</b> for every caballero (Cloudflare D1); wallet identities are proven with a signed message. Nothing here sends a transaction or pays out.</Match>
          <Match when={true}><b>Preview — data is local</b> to this browser{api.mode() === "demo" ? " (demo mode)" : " (the corner API isn't deployed here)"}. Launch data, reveals and records still come from the KYP {api.mode() === "demo" ? "demo simulation" : "contracts"}. Sample caballeros are marked "sample". Nothing here sends a transaction or pays out.</Match>
        </Switch>
        <Show when={loadErr()}><div class="sub">Sync error: {loadErr()}</div></Show>
      </div>

      <div class="card cc-hero">
        <div class="cc-head">
          <div><h2>Cabal Corner</h2><p class="muted">Where the caballeros plan the launch.</p></div>
          <span class="pill violet">Preview</span>
        </div>
        <div class="cc-features">
          <For each={FEATURES}>{([t, d]) => <div class="cc-feature"><b>{t}</b><span class="sub">{d}</span></div>}</For>
        </div>
      </div>

      <Identity synced={synced()} me={me()} joined={!!mine()} onJoin={() => act({ type: "join", skills: [] }, "You're on the roster. Pick your skills.")} refresh={() => setTick((t) => t + 1)} />

      <Show when={mine()}>
        <div class="grid g2">
          <div class="card">
            <div class="cc-head"><h3>Your skills</h3><Show when={mine()}><span class={`cc-status s-${activity(st(), me()!, now()).status.replace(" ", "-")}`}>{activity(st(), me()!, now()).status} · {activity(st(), me()!, now()).score} pts</span></Show></div>
            <p class="sub">Tap what you bring. It shows on the roster and shapes your missions.</p>
            <div class="cc-chips" style={{ "margin-top": "12px" }}>
              <For each={SKILLS}>{(s) => {
                const on = () => mySkills().includes(s.id);
                return <button class={`cc-skill k-${s.id} ${on() ? "on" : "off"}`} aria-pressed={on()} title={s.blurb}
                  onClick={() => act({ type: "skills", skills: on() ? mySkills().filter((x) => x !== s.id) : [...mySkills(), s.id] })}>{s.emoji} {s.label}</button>;
              }}</For>
            </div>
          </div>
          <div class="card" data-testid="corner-missions">
            <div class="cc-head"><h3>Today's missions</h3><span class="sub">{today} UTC · {missions().filter((m) => isDone(m.id)).length}/{missions().length} done</span></div>
            <ul class="cc-list">
              <For each={missions()}>{(m) => (
                <li>
                  <label class="cc-check">
                    <input type="checkbox" checked={isDone(m.id)} onChange={() => act({ type: "mission", mission: m.id, text: m.text }, isDone(m.id) ? undefined : "+1 point")} />
                    <span class={isDone(m.id) ? "done" : ""}>{m.text}</span>
                  </label>
                  <span class={`cc-skill sm k-${m.skill}`}>{skillById(m.skill)?.emoji} {skillById(m.skill)?.label}</span>
                </li>
              )}</For>
            </ul>
            <Show when={!mySkills().length}><p class="sub">No skills picked yet, so you get community missions.</p></Show>
          </div>
        </div>
      </Show>

      <div class="grid g2">
        <div class="card" data-testid="corner-roster">
          <div class="cc-head"><h3>Roster</h3><span class="sub">{roster().length} caballeros{hiddenSlots() ? ` · ${hiddenSlots()} presale slots still hidden on-chain` : ""}</span></div>
          <ul class="cc-roster">
            <For each={roster()} fallback={<li class="sub">Nobody here yet. Be the first to join.</li>}>{(r: any) => (
              <li>
                <div class="cc-rowtop">{W({ id: r.id })}<span class={`cc-status s-${r.act.status.replace(" ", "-")}`} title={`${r.act.score} points in 7 days${r.act.quietDays != null ? ` · last active ${r.act.quietDays}d ago` : ""}`}>{r.act.status} · {r.act.score}</span></div>
                <SkillChips skills={r.skills} />
              </li>
            )}</For>
          </ul>
          <Show when={!synced() && st().members.some((m: any) => m.sample)}>
            <button class="btn sm ghost" style={{ "margin-top": "12px" }} onClick={() => { store.clearSamples(l().id); setTick((t) => t + 1); }}>Clear sample data</button>
          </Show>
        </div>
        <div class="stack">
          <div class="card" data-testid="corner-mix">
            <div class="cc-head"><h3>Team mix</h3><span class={`pill ${mix().ready ? "live" : "warn"}`}>{mix().score}% covered</span></div>
            <ul class="cc-mix">
              <For each={mix().rows}>{(r) => (
                <li class={r.status}>
                  <span>{r.emoji} <b>{r.label}</b> <span class="sub">{r.blurb}</span></span>
                  <span class="cc-mixn">{r.have}/{r.need}{r.status === "missing" ? " · gap" : r.status === "thin" ? " · thin" : " ✓"}</span>
                </li>
              )}</For>
            </ul>
            <Show when={!mix().ready} fallback={<div class="notice ok" style={{ "margin-top": "12px" }}>Every skill is covered. Ready for launch day.</div>}>
              <div class="notice warn" style={{ "margin-top": "12px" }}>Before launch: {[...mix().missing, ...mix().thin].map((id) => skillById(id)?.label).join(", ")} {mix().missing.length + mix().thin.length > 1 ? "need" : "needs"} more hands.</div>
            </Show>
          </div>
          <div class="card" data-testid="corner-passengers">
            <div class="cc-head"><h3>No passengers</h3><span class={`pill ${passengers().length ? "warn" : "live"}`}>{passengers().length ? `${passengers().length} flagged` : "everyone pulling weight"}</span></div>
            <p class="sub">Points over 7 days: mission 1 · vote 1 · proposal 2 · entry 2 · delivery 3 · win 5. Three quiet days after joining flags a passenger.</p>
            <ul class="cc-list" style={{ "margin-top": "8px" }}>
              <For each={[...roster()].sort((a: any, b: any) => b.act.score - a.act.score).slice(0, 6)}>{(r: any, i) => (
                <li><span>{i() + 1}. {display(r.id)}</span><span class={`cc-status s-${r.act.status.replace(" ", "-")}`}>{r.act.score} pts</span></li>
              )}</For>
            </ul>
          </div>
        </div>
      </div>

      <Bounties l={l()} st={st} act={act} me={me()} rosterSize={roster().length} W={W} synced={synced()} />

      <div class="grid g2">
        <AgentPanel l={l()} mix={mix} roster={() => roster().length} passengers={passengers} bounties={() => st().bounties} />
        <Feed events={() => st().events} W={W} />
      </div>

      <Record initial={wallet() ?? ""} />
    </div>
  );
}

function Identity(p: { synced: boolean; me: string | null; joined: boolean; onJoin: () => void; refresh: () => void }) {
  const [name, setName] = createSignal(store.getGuest());
  const [busy, setBusy] = createSignal(false);
  const needsSignIn = () => p.synced && !!wallet() && store.session()?.accountId !== wallet();
  const guest = (e: Event) => {
    e.preventDefault();
    const n = name().trim().replace(/[^\w.-]/g, "").slice(0, 24);
    if (n.length < 2) return toast("Guest name: 2+ letters", "bad");
    store.setGuestName(n); p.refresh();
  };
  return (
    <Show when={!p.joined || needsSignIn()}>
      <div class="card cc-join" data-testid="corner-identity">
        <Switch>
          <Match when={needsSignIn()}>
            <div class="cc-head"><h3>Sign in as <span class="mono">{short(wallet()!)}</span></h3>
              <button class="btn sm primary" disabled={busy()} onClick={async () => { setBusy(true); try { await store.signInCorner(); toast("Signed in to Cabal Corner", "ok"); p.refresh(); } catch (e: any) { toast(e?.message ?? String(e), "bad"); } finally { setBusy(false); } }}>{busy() ? "Waiting for wallet…" : "Sign message"}</button></div>
            <p class="sub" data-testid="corner-signin-copy">New wallet connected. Already joined with <span class="mono">{short(wallet()!)}</span>? Sign once to load your profile, skills and votes. Your wallet signs a short message (NEP-413) so caballeros know it's really you; it is not a transaction and cannot move funds. This browser remembers each wallet's sign-in for 7 days, so switching back won't ask again. Until your presale wave is revealed, others see you as an alias.</p>
          </Match>
          <Match when={p.me}>
            <div class="cc-head"><h3>Join the corner as <span class="mono">{display(p.me)}</span></h3><button class="btn sm primary" data-testid="corner-join" onClick={p.onJoin}>Join the roster</button></div>
            <p class="sub">{p.me!.startsWith("guest:") ? "Guest profile: not tied to a wallet, so it never counts toward a KYP record." : p.synced ? "Signed in with your wallet." : "Wallet profile, stored in this browser only in preview mode."}</p>
          </Match>
          <Match when={true}>
            <div class="cc-head"><h3>Step into the corner</h3><button class="btn sm primary" onClick={connectWallet}>Connect wallet</button></div>
            <p class="sub">Connect your {NETWORK_NAME} wallet so your work counts toward your KYP record, or look around as a guest.</p>
            <form class="cc-inline" onSubmit={guest}>
              <input placeholder="guest name" value={name()} onInput={(e) => setName(e.currentTarget.value)} aria-label="Guest name" />
              <button class="btn sm" type="submit">Continue as guest</button>
            </form>
          </Match>
        </Switch>
      </div>
    </Show>
  );
}

const STATUS_LABEL: Record<string, [string, string]> = {
  proposed: ["open", "Proposed"], agreed: ["live", "Agreed"], open: ["live", "Open for entries"],
  claimed: ["violet", "In progress"], submitted: ["warn", "Delivered · needs approval"], done: ["live", "Done"],
};

function Bounties(p: { l: LaunchView; st: () => any; act: (a: any, ok?: string) => Promise<boolean>; me: string | null; rosterSize: number; W: (x: { id: string | null }) => any; synced: boolean }) {
  const [kind, setKind] = createSignal<"bounty" | "competition">("bounty");
  const [title, setTitle] = createSignal("");
  const [details, setDetails] = createSignal("");
  const [skill, setSkill] = createSignal("creator");
  const [reward, setReward] = createSignal("");
  const [filter, setFilter] = createSignal<"active" | "done">("active");
  const share = () => p.l.fee_split.community_bps / 100;
  const pool = () => p.l.fee_balances.filter(([t]) => t === p.l.quote_token_id).map(([, b]) => fmtQ(b)).join(", ");
  const joined = () => !!p.me && p.st().members.some((m: any) => m.id === p.me);
  const list = () => p.st().bounties.filter((b: any) => (filter() === "done") === (b.status === "done"));
  const propose = async (e: Event) => {
    e.preventDefault();
    if (await p.act({ type: "propose", kind: kind(), title: title(), details: details(), skill: skill(), reward: reward() }, "Proposed. Caballeros vote to agree it.")) { setTitle(""); setDetails(""); setReward(""); }
  };
  return (
    <div class="card" data-testid="corner-bounties">
      <div class="cc-head">
        <h3>Bounties & competitions</h3>
        <span class="sub">Funded from the fee pool · community share {share()}% → <span class="mono">{short(p.l.fee_split.community_account)}</span>{pool() ? ` · fees waiting ${pool()}` : ""}</span>
      </div>
      <p class="sub">Propose → a majority ({majority(p.rosterSize)} of {p.rosterSize}) agrees → bounties are claimed, delivered and approved by majority; competitions take entries and close on votes. Rewards are tracked here and paid by the community account; v1 moves no funds.</p>
      <Show when={joined()} fallback={<p class="sub" style={{ "margin-top": "8px" }}>{wallet() && !store.session() && p.synced ? `Sign in as ${short(wallet()!)} above to propose and vote (if this wallet already joined, signing in brings your profile back).` : "Join the roster to propose and vote."}</p>}>
        <form class="cc-form" onSubmit={propose}>
          <div class="cc-seg" role="tablist">
            <button type="button" class={kind() === "bounty" ? "on" : ""} onClick={() => setKind("bounty")}>Bounty</button>
            <button type="button" class={kind() === "competition" ? "on" : ""} onClick={() => setKind("competition")}>Competition</button>
          </div>
          <input placeholder={kind() === "bounty" ? "e.g. Sticker pack for the chat" : "e.g. Best launch-day meme"} value={title()} onInput={(e) => setTitle(e.currentTarget.value)} aria-label="Title" maxLength={80} />
          <input placeholder="Details (optional)" value={details()} onInput={(e) => setDetails(e.currentTarget.value)} aria-label="Details" maxLength={280} />
          <select value={skill()} onChange={(e) => setSkill(e.currentTarget.value)} aria-label="Skill"><For each={SKILLS}>{(s) => <option value={s.id}>{s.label}</option>}</For></select>
          <input placeholder="Reward, e.g. 20% of community share" value={reward()} onInput={(e) => setReward(e.currentTarget.value)} aria-label="Reward" maxLength={60} />
          <button class="btn sm primary" type="submit">Propose</button>
        </form>
      </Show>
      <div class="cc-seg" style={{ "margin-top": "14px" }}>
        <button class={filter() === "active" ? "on" : ""} onClick={() => setFilter("active")}>Active</button>
        <button class={filter() === "done" ? "on" : ""} onClick={() => setFilter("done")}>Done</button>
      </div>
      <ul class="cc-bounties">
        <For each={list()} fallback={<li class="sub">Nothing here yet.</li>}>{(b: any) => <BountyItem b={b} {...p} joined={joined()} />}</For>
      </ul>
    </div>
  );
}

function BountyItem(p: { b: any; act: (a: any, ok?: string) => Promise<boolean>; me: string | null; rosterSize: number; joined: boolean; W: (x: { id: string | null }) => any }) {
  const b = () => p.b;
  const [link, setLink] = createSignal("");
  const s = () => bountyStatus(b(), p.rosterSize);
  const lab = () => STATUS_LABEL[b().status] ?? ["", b().status];
  const linkForm = (type: "submit" | "enter", label: string) => (
    <form class="cc-inline" onSubmit={async (e) => { e.preventDefault(); if (await p.act({ type, id: b().id, link: link() }, type === "submit" ? "Delivered. Caballeros approve it." : "Entry in.")) setLink(""); }}>
      <input placeholder="https://link-to-the-work" value={link()} onInput={(e) => setLink(e.currentTarget.value)} aria-label="Link" />
      <button class="btn sm primary" type="submit">{label}</button>
    </form>
  );
  return (
    <li class="cc-bounty">
      <div class="cc-rowtop">
        <div>
          <span class="cc-kind">{b().kind === "competition" ? "🏆 Competition" : "🎯 Bounty"}</span> <b>{b().title}</b> <span class={`cc-skill sm k-${b().skill}`}>{skillById(b().skill)?.label}</span>
          <Show when={b().sample}><span class="cc-tag dim">sample</span></Show>
        </div>
        <span class={`pill ${lab()[0]}`}>{lab()[1]}</span>
      </div>
      <Show when={b().details}><div class="sub">{b().details}</div></Show>
      <div class="sub">Reward: {b().reward} · proposed by {p.W({ id: b().by })}</div>

      <Show when={b().status === "proposed"}>
        <div class="cc-rowtop">
          <span class="sub">{s().votes}/{s().needed} votes to agree</span>
          <Show when={p.joined}><button class="btn sm ghost" onClick={() => p.act({ type: "vote", id: b().id })}>{b().votes.includes(p.me) ? "Unvote" : "Vote to agree"}</button></Show>
        </div>
      </Show>
      <Show when={b().kind === "bounty" && b().status === "agreed" && p.joined}>
        <div><button class="btn sm primary" onClick={() => p.act({ type: "claim", id: b().id }, "It's yours. Deliver a link when done.")}>Take it on</button></div>
      </Show>
      <Show when={b().kind === "bounty" && ["claimed", "submitted", "done"].includes(b().status)}>
        <div class="sub">Taken on by {p.W({ id: b().claimant })}</div>
      </Show>
      <Show when={b().kind === "bounty" && b().claimant === p.me && ["claimed", "submitted"].includes(b().status)}>{linkForm("submit", b().status === "submitted" ? "Update delivery" : "Deliver")}</Show>
      <Show when={b().submission}>
        <div class="cc-rowtop">
          <a class="link" href={b().submission.link} target="_blank" rel="noopener noreferrer nofollow">{b().submission.link}</a>
          <Show when={b().status === "submitted"}>
            <span class="sub">{b().approvals.length}/{approvalsNeeded(p.rosterSize)} approvals</span>
            <Show when={p.joined && b().claimant !== p.me}><button class="btn sm ghost" onClick={() => p.act({ type: "approve", id: b().id })}>{b().approvals.includes(p.me) ? "Unapprove" : "Approve"}</button></Show>
          </Show>
        </div>
      </Show>
      <Show when={b().kind === "competition" && b().status !== "proposed"}>
        <ul class="cc-entries">
          <For each={[...b().entries].sort((x: any, y: any) => y.votes.length - x.votes.length)} fallback={<li class="sub">No entries yet.</li>}>{(e: any) => (
            <li class={b().winner === e.id ? "win" : ""}>
              <span>{b().winner === e.id ? "🏆 " : ""}{p.W({ id: e.by })} · <a class="link" href={e.link} target="_blank" rel="noopener noreferrer nofollow">entry</a></span>
              <span class="cc-vote">
                <span class="sub">{e.votes.length} vote{e.votes.length === 1 ? "" : "s"}</span>
                <Show when={b().status === "open" && p.joined && e.by !== p.me}><button class="btn sm ghost" onClick={() => p.act({ type: "voteEntry", id: b().id, entry: e.id })}>{e.votes.includes(p.me) ? "Unvote" : "Vote"}</button></Show>
              </span>
            </li>
          )}</For>
        </ul>
        <Show when={b().status === "open" && p.joined && !b().entries.some((e: any) => e.by === p.me)}>{linkForm("enter", "Enter")}</Show>
        <Show when={b().status === "open" && b().by === p.me}><button class="btn sm" onClick={() => p.act({ type: "close", id: b().id }, "Competition closed. Winner picked by votes.")}>Close & pick winner</button></Show>
      </Show>
    </li>
  );
}

function AgentPanel(p: { l: LaunchView; mix: () => any; roster: () => number; passengers: () => string[]; bounties: () => any[] }) {
  let el!: HTMLDivElement;
  const [engine, setEngine] = createSignal("retrieval");
  const context = () => ({ symbol: p.l.symbol, status: p.l.status, raised: fmtQ(p.l.total_raised, 0), mix: p.mix(), rosterSize: p.roster(), passengers: p.passengers(), bounties: p.bounties().map((b) => ({ title: b.title, status: b.status })) });
  const ask = async (q: string, ctx: any) => {
    const remote = await store.askAgent(q, ctx).catch(() => null);
    if (remote) { setEngine(remote.engine ?? "retrieval"); return remote; }
    return agentAnswer(q, ctx);
  };
  onMount(async () => {
    store.apiHealth().then((h) => h.ai && setEngine("workers-ai"));
    const { mountAgentChat } = await import("./react/AgentChat");
    const off = mountAgentChat(el, { symbol: p.l.symbol, context, ask });
    onCleanup(off);
  });
  return (
    <div class="card" data-testid="corner-agent">
      <div class="cc-head"><h3>Your AI agent</h3><span class="pill violet">{engine() === "workers-ai" ? "Workers AI + NEAR notes" : "Preview · retrieval"}</span></div>
      <p class="sub">Answers from a curated library of {KB.length} NEAR ecosystem notes (MiniSearch retrieval) plus this launch's live data, and cites what it used. {engine() === "workers-ai" ? "A small Workers AI model writes the answer from those notes." : "No LLM is called in this mode."}</p>
      <div ref={el} class="cc-agent-mount"><div class="skeleton" /></div>
    </div>
  );
}

function Feed(p: { events: () => any[]; W: (x: { id: string | null }) => any }) {
  const ev = () => [...p.events()].sort((a, b) => b.ts - a.ts).slice(0, 25);
  return (
    <div class="card" data-testid="corner-feed">
      <div class="cc-head"><h3>Built in the open</h3><span class="sub">latest activity</span></div>
      <p class="sub">Every action is logged here. Hidden presalers show as an alias; when the chain reveals their wave, their wallet is tagged on everything they did.</p>
      <ul class="cc-feed">
        <For each={ev()} fallback={<li class="sub">Nothing yet.</li>}>{(e) => (
          <li><span>{p.W({ id: e.actor })} <span class="muted">{e.text}</span></span><span class="sub">{ago(e.ts)}</span></li>
        )}</For>
      </ul>
    </div>
  );
}

interface RecordRow { l: LaunchView; role: string; detail: string }
async function loadRecord(acct: string) {
  const launches = await api.list();
  const rows = (await Promise.all(launches.map(async (l): Promise<RecordRow | null> => {
    const roles: string[] = [], details: string[] = [];
    if (l.launcher === acct) roles.push("Launcher");
    const ps = await api.presalers(l.id).catch(() => [] as PresalerView[]);
    const mine = ps.find((x) => x.account_id === acct);
    if (mine) { roles.push("Presaler"); details.push(`${fmtQ(mine.quote, 2)} in · wave ${mine.wave}`); }
    const pos = await api.position(l.id, acct).catch(() => null);
    if (pos && BigInt(pos.total) > 0n) {
      if (!mine) roles.push("Presaler");
      details.push(`${tok(pos.total).toLocaleString(undefined, { maximumFractionDigits: 0 })} $${l.symbol} locked, ${tok(pos.claimed).toLocaleString(undefined, { maximumFractionDigits: 0 })} claimed`);
    }
    return roles.length ? { l, role: roles.join(" + "), detail: details.join(" · ") } : null;
  }))).filter((x): x is RecordRow => !!x);
  const corner = await store.remoteRecord(acct).catch(() => null);
  return { rows, corner: corner?.corners ?? null };
}

function Record(p: { initial: string }) {
  const [acct, setAcct] = createSignal(p.initial);
  const [input, setInput] = createSignal(p.initial);
  const [rec] = createResource(acct, (a) => (a ? loadRecord(a) : Promise.resolve({ rows: [], corner: null })));
  return (
    <div class="card" data-testid="corner-record">
      <div class="cc-head"><h3>KYP record</h3><span class="pill live">{api.mode() === "demo" ? "demo chain" : `on-chain · ${NETWORK_NAME}`}</span></div>
      <p class="sub">Every launch an account led or presold in, read from <span class="mono">{CONFIG.coordinator || "the demo coordinator"}</span> and its lock, plus Cabal Corner contributions where that account is public. Launchers check this before sending the next invite.</p>
      <form class="cc-inline" style={{ "margin-top": "10px" }} onSubmit={(e) => { e.preventDefault(); setAcct(input().trim()); }}>
        <input placeholder="account.testnet" value={input()} onInput={(e) => setInput(e.currentTarget.value)} aria-label="NEAR account" />
        <button class="btn sm" type="submit">Look up</button>
      </form>
      <Show when={acct()} fallback={<p class="sub" style={{ "margin-top": "10px" }}>Connect a wallet or enter an account.</p>}>
        <Show when={!rec.loading} fallback={<div class="skeleton" style={{ "margin-top": "12px" }} />}>
          <div class="grid g2" style={{ "margin-top": "10px" }}>
            <div>
              <div class="label">Launches (on-chain)</div>
              <ul class="cc-list">
                <For each={rec()?.rows ?? []} fallback={<li class="sub">No KYP launches found for <span class="mono">{acct()}</span> yet.</li>}>{(r) => (
                  <li><a class="link" href={`/launch?id=${r.l.id}`}>{r.l.name} (${r.l.symbol}) #{r.l.id}</a><span class="sub">{r.role}{r.detail ? ` · ${r.detail}` : ""}</span></li>
                )}</For>
              </ul>
            </div>
            <div>
              <div class="label">Cabal Corner contributions</div>
              <Show when={rec()?.corner} fallback={<p class="sub">Synced contributions show here once the corner API is live. In preview mode work stays in this browser.</p>}>
                <ul class="cc-list">
                  <For each={rec()!.corner!} fallback={<li class="sub">No public corner work yet.</li>}>{(c) => (
                    <li><a class="link" href={`/corner?id=${c.launchId}`}>${c.symbol} #{c.launchId}</a><span class="sub">{c.points} pts · {c.missions} missions · {c.wins} wins{c.wave != null ? ` · revealed wave ${c.wave}` : ""}</span></li>
                  )}</For>
                </ul>
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}

function Picker() {
  const [launches] = useLive(() => api.list());
  return (
    <div class="stack" style={{ padding: "36px 0 72px" }}>
      <div>
        <h1>Cabal Corner</h1>
        <p class="lead">Where the caballeros plan the launch. Pick a launch to open its corner.</p>
      </div>
      <div class="notice warn">Early preview · {NETWORK_NAME}. Each launch has its own corner: roster and skills, team mix, daily missions, bounties and competitions, an AI agent, and the KYP record.</div>
      <Show when={launches()} fallback={<div class="skeleton" />}>
        <div class="grid g2">
          <For each={launches()} fallback={<div class="card"><h3>No launches yet</h3></div>}>{(l) => (
            <a class="card cc-pick" href={`/corner?id=${l.id}`} data-testid="corner-pick">
              <TokenBadge symbol={l.symbol} icon={l.icon} />
              <div style={{ flex: 1 }}><h3>{l.name}</h3><span class="sub">${l.symbol} · #{l.id} · {l.filled_open_slots}/{l.open_slots} presalers</span></div>
              <StatusPill status={l.status} />
            </a>
          )}</For>
        </div>
      </Show>
    </div>
  );
}

export default function CabalCorner() {
  const hasId = new URLSearchParams(location.search).has("id");
  return (
    <Show when={hasId} fallback={<Picker />}>
      <WithLaunch tab="corner">{(l) => <Corner l={l()} />}</WithLaunch>
    </Show>
  );
}
