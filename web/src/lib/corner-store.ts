// Cabal Corner storage. "synced": the site's /api/corner Worker + Cloudflare D1, shared by every
// caballero, wallet identities proven with a NEP-413 signature. "local": this browser only (demo
// mode, or when the API isn't deployed), seeded with clearly-labelled sample caballeros.
import { createSignal } from "solid-js";
import { api } from "./source";
import { CONFIG, NETWORK } from "./config";
import { account as wallet, signMessage } from "./wallet";
import { applyAction, emptyState, hash } from "./corner.mjs";
import { signInMessage, b64 } from "./nep413.mjs";

export type StoreMode = "synced" | "local";
export interface CornerView { state: any; viewer: string | null; verified: boolean; reveals: Record<string, number>; launcher?: string }

const GUEST_KEY = "kyp-corner-guest";
const sessKey = () => `kyp-corner-session:${NETWORK}`;
const localKey = (id: number) => `kyp-corner-v2:${api.mode()}:${CONFIG.coordinator || "demo"}:${id}`;

export const getGuest = () => { try { return localStorage.getItem(GUEST_KEY) ?? ""; } catch { return ""; } };
export const setGuestName = (n: string) => { try { n ? localStorage.setItem(GUEST_KEY, n) : localStorage.removeItem(GUEST_KEY); } catch {} };

interface Session { token: string; accountId: string; exp: number }
function getSession(): Session | null {
  try { const s = JSON.parse(localStorage.getItem(sessKey()) ?? "null"); return s && s.exp > Date.now() ? s : null; } catch { return null; }
}
const [session, setSession] = createSignal<Session | null>(typeof localStorage === "undefined" ? null : getSession());
export { session };
export function signOutCorner() { try { localStorage.removeItem(sessKey()); } catch {} setSession(null); }

let healthP: Promise<{ ok: boolean; ai: boolean }> | null = null;
export function apiHealth() {
  if (api.mode() === "demo") return Promise.resolve({ ok: false, ai: false });
  return (healthP ??= fetch("/api/corner/health").then((r) => (r.ok ? r.json() : { ok: false, ai: false })).catch(() => ({ ok: false, ai: false })));
}
export const storeMode = async (): Promise<StoreMode> => ((await apiHealth()).ok ? "synced" : "local");

/** Prove wallet ownership once (NEP-413 signature, no transaction) and keep a 7-day session. */
export async function signInCorner() {
  const acct = wallet();
  if (!acct) throw new Error("Connect a wallet first");
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const message = signInMessage(acct, Date.now());
  const recipient = location.host;
  const signed = await signMessage({ message, recipient, nonce });
  const r = await fetch("/api/corner/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId: signed.accountId || acct, publicKey: signed.publicKey, signature: signed.signature, message, nonce: b64(nonce), recipient, network: NETWORK }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Sign-in failed");
  localStorage.setItem(sessKey(), JSON.stringify(j));
  setSession(j);
  return j as Session;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const s = session();
  if (s && s.accountId === wallet()) h.authorization = `Bearer ${s.token}`;
  else if (getGuest()) h["x-corner-guest"] = getGuest();
  return h;
}
const base = (id: number) => `/api/corner/${NETWORK}/${encodeURIComponent(CONFIG.coordinator)}/${id}`;

export async function remoteGet(id: number): Promise<CornerView> {
  const r = await fetch(base(id), { headers: headers() });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Couldn't load the corner");
  return j;
}
export async function remoteAct(id: number, action: any): Promise<CornerView> {
  const r = await fetch(base(id), { method: "POST", headers: headers(), body: JSON.stringify({ action }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? "Action failed");
  return j;
}
export async function remoteRecord(account: string): Promise<{ corners: { launchId: number; symbol: string; points: number; wins: number; missions: number; wave: number | null }[] } | null> {
  if (!(await apiHealth()).ok) return null;
  const r = await fetch(`/api/corner/record/${NETWORK}/${encodeURIComponent(CONFIG.coordinator)}/${encodeURIComponent(account)}`, { headers: headers() });
  return r.ok ? r.json() : null;
}
export async function askAgent(q: string, ctx: any): Promise<{ text: string; sources: { title: string }[]; kind: string; engine?: string } | null> {
  if (!(await apiHealth()).ok) return null;
  const r = await fetch("/api/corner/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q, ctx }) });
  return r.ok ? r.json() : null;
}

/** Who acts in local mode: the connected wallet (unverified, local only) or the guest name. */
export const localViewer = () => wallet() ?? (getGuest() ? `guest:${getGuest()}` : null);

function seedLocal(now = Date.now()): any {
  const day = 86400e3;
  const s: any = emptyState();
  const add = (id: string, skills: string[], joined: number, last: number) => s.members.push({ id, kind: "sample", verified: false, skills, joinedAt: now - joined * day, lastActive: now - last * day, sample: true });
  add("sample-dev", ["dev", "trader"], 5, 0.2);
  add("sample-creator", ["creator"], 5, 0.5);
  add("sample-community", ["community", "creator"], 4, 3.5);
  const ev = (actor: string, type: string, text: string, ago: number) => s.events.push({ ts: now - ago * day, actor, type, text, ref: null });
  ev("sample-community", "join", "joined the corner", 4);
  ev("sample-community", "mission", "Welcome every new member in chat today", 3.6);
  ev("sample-dev", "mission", "Poke the TWAP observer once today", 1);
  ev("sample-creator", "propose", 'proposed competition "Best launch-day meme"', 0.8);
  ev("sample-dev", "vote", 'voted on "Best launch-day meme"', 0.6);
  ev("sample-creator", "mission", "Post one meme that explains the locked presale", 0.5);
  ev("sample-dev", "mission", "Review the token metadata", 0.2);
  s.bounties.push(
    { id: "s1", kind: "competition", title: "Best launch-day meme", details: "Most votes wins. One entry each.", skill: "creator", reward: "40% of the community share, week 1", by: "sample-creator", votes: ["sample-creator", "sample-dev"], createdAt: now - 0.8 * day, status: "open", claimant: null, submission: null, approvals: [], entries: [{ id: "e1", by: "sample-creator", link: "https://example.com/meme-1", note: "sample entry", votes: ["sample-dev"], at: now - 0.4 * day }], winner: null, sample: true },
    { id: "s2", kind: "bounty", title: "Sticker pack for the chat", details: "4 stickers in the token's style.", skill: "designer", reward: "15% of the community share", by: "sample-community", votes: ["sample-community"], createdAt: now - 2 * day, status: "proposed", claimant: null, submission: null, approvals: [], entries: [], winner: null, sample: true },
  );
  return s;
}

export function localGet(id: number): CornerView {
  let state: any;
  try { state = JSON.parse(localStorage.getItem(localKey(id)) ?? "null"); } catch {}
  if (!state) { state = seedLocal(); localStorage.setItem(localKey(id), JSON.stringify(state)); }
  return { state, viewer: localViewer(), verified: false, reveals: {} };
}
export function localAct(id: number, action: any): CornerView {
  const v = localGet(id);
  const me = localViewer();
  if (!me) throw new Error("Pick a guest name or connect a wallet");
  const next = applyAction(v.state, { id: me, kind: wallet() ? "wallet" : "guest", verified: false }, action, Date.now());
  localStorage.setItem(localKey(id), JSON.stringify(next));
  return { ...v, state: next, viewer: me };
}
export function clearSamples(id: number) {
  const v = localGet(id);
  const st = v.state;
  st.members = st.members.filter((m: any) => !m.sample);
  st.bounties = st.bounties.filter((b: any) => !b.sample);
  st.events = st.events.filter((e: any) => !String(e.actor).startsWith("sample-"));
  localStorage.setItem(localKey(id), JSON.stringify(st));
}
export const aliasHint = (id: string) => `Caballero ${(hash(id) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}`;
