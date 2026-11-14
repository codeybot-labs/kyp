// kyp-web Worker. Static assets are served by Cloudflare's asset layer as before; this script only
// runs for /api/* (assets.run_worker_first), which is the Cabal Corner API backed by D1.
// Cost guardrails: tiny JSON bodies, capped rows (see LIMITS), best-effort per-IP write throttle,
// and Workers AI is OFF unless CORNER_AI = "on" (then capped per day, well under the free allocation).
import { applyAction, maskState, emptyState, activity, agentAnswer, LIMITS } from "../src/lib/corner.mjs";
import { retrieve } from "../src/lib/corner-kb.mjs";
import { verifySignature, issuedAtOf, signInMessage, unb64, hex } from "../src/lib/nep413.mjs";

const RPC = { testnet: ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"], mainnet: ["https://rpc.mainnet.fastnear.com", "https://rpc.mainnet.near.org"] };
const SESSION_TTL = 7 * 86400e3;
const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const fail = (msg, status = 400) => json({ error: msg }, status);

const allowed = (env) => new Set(String(env.CORNER_COORDINATORS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const rpcFor = (env, network) => {
  const own = network === "mainnet" ? env.RPC_MAINNET : env.RPC_TESTNET;
  return [...(own ? [own] : []), ...RPC[network === "mainnet" ? "mainnet" : "testnet"]];
};

/** JSON-RPC query with fallback: a rate-limited or flaky RPC (429/5xx/non-JSON) tries the next one.
 * (An HTML 429 page from the first RPC used to surface as an HTTP 500 during fast wallet switching.) */
async function rpc(urls, params) {
  let last;
  for (const url of [].concat(urls)) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "kyp", method: "query", params }) });
      if (!r.ok) throw new Error(`RPC ${r.status}`);
      const j = await r.json();
      if (j.error) { const e = new Error(j.error?.cause?.name || j.error.message || "RPC error"); e.final = true; throw e; }
      return j.result;
    } catch (e) { last = e; if (e?.final) throw e; }
  }
  throw last ?? new Error("RPC unavailable");
}
async function view(env, network, contract, method, args) {
  const res = await rpc(rpcFor(env, network), { request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (res.error) throw new Error(res.error);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(res.result)));
}

// Per-isolate cache of who is public on a launch (launcher + revealed presalers), 30 s.
const pubCache = new Map();
async function publicInfo(env, network, coordinator, id) {
  const k = `${network}:${coordinator}:${id}`;
  const hit = pubCache.get(k);
  if (hit && hit.at > Date.now() - 30e3) return hit;
  let launch, presalers;
  try {
    [launch, presalers] = await Promise.all([
      view(env, network, coordinator, "get_launch", { launch_id: id }),
      view(env, network, coordinator, "get_presalers", { launch_id: id }).catch(() => []),
    ]);
  } catch (e) {
    if (hit) return hit; // RPC hiccup: a slightly stale reveal list beats an error
    // Unknown who is public: show everyone but the viewer as an alias (fail closed), don't error.
    return { at: 0, launcher: null, symbol: "", revealed: new Map(), degraded: true };
  }
  if (!launch) throw Object.assign(new Error("No such launch"), { status: 404 });
  const revealed = new Map(presalers.filter((p) => p.account_id).map((p) => [p.account_id, p.wave]));
  const v = { at: Date.now(), launcher: launch.launcher, symbol: launch.symbol, revealed };
  pubCache.set(k, v);
  if (pubCache.size > 500) pubCache.delete(pubCache.keys().next().value);
  return v;
}

async function alias(salt, id) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}|${id}`)));
  return `Caballero ${hex(d.slice(0, 2)).toUpperCase()}`;
}
async function masked(state, salt, pub, viewer) {
  const ids = [...new Set(state.members.map((m) => m.id))];
  const al = new Map(await Promise.all(ids.map(async (id) => [id, await alias(salt, id)])));
  const isPublic = (id) => id === viewer || id === pub.launcher || pub.revealed.has(id);
  return maskState(state, isPublic, (id) => al.get(id) ?? "Caballero ????");
}

async function sessionAccount(env, req) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!/^[0-9a-f]{64}$/.test(t)) return null;
  const row = await env.CORNER_DB.prepare("SELECT account, exp FROM sessions WHERE token = ?").bind(t).first();
  return row && row.exp > Date.now() ? row.account : null;
}
function guestOf(req) {
  const g = (req.headers.get("x-corner-guest") ?? "").replace(/[^\w.-]/g, "").slice(0, LIMITS.name);
  return g.length >= 2 ? `guest:${g}` : null;
}

// best-effort write throttle per IP per isolate
const writes = new Map();
function throttled(req, max = 60) {
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const now = Date.now();
  const w = (writes.get(ip) ?? []).filter((t) => t > now - 60e3);
  w.push(now);
  writes.set(ip, w);
  if (writes.size > 5000) writes.clear();
  return w.length > max;
}

async function readBody(req) {
  const t = await req.text();
  if (t.length > 4096) throw Object.assign(new Error("Body too large"), { status: 413 });
  try { return JSON.parse(t || "{}"); } catch { throw Object.assign(new Error("Bad JSON"), { status: 400 }); }
}

async function loadCorner(env, key) {
  const row = await env.CORNER_DB.prepare("SELECT state, salt, version FROM corners WHERE key = ?").bind(key).first();
  if (row) return { state: JSON.parse(row.state), salt: row.salt, version: row.version, exists: true };
  return { state: emptyState(), salt: hex(crypto.getRandomValues(new Uint8Array(16))), version: 0, exists: false };
}
async function saveCorner(env, key, c, next) {
  const now = Date.now();
  const body = JSON.stringify(next);
  if (body.length > 400_000) throw Object.assign(new Error("Corner is full"), { status: 409 });
  const r = c.exists
    ? await env.CORNER_DB.prepare("UPDATE corners SET state = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?").bind(body, now, key, c.version).run()
    : await env.CORNER_DB.prepare("INSERT OR IGNORE INTO corners (key, state, salt, version, updated_at) VALUES (?, ?, ?, 1, ?)").bind(key, body, c.salt, now).run();
  return (r.meta?.changes ?? 0) === 1;
}

async function handleAuth(env, req) {
  const b = await readBody(req);
  const { accountId, publicKey, signature, message, nonce } = b;
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId ?? "")) return fail("Bad account");
  // The signed recipient must be this site (prevents replaying a signature made for another app).
  const hosts = new Set([new URL(req.url).host, ...String(env.CORNER_RECIPIENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean)]);
  const recipient = String(b.recipient ?? "");
  if (!hosts.has(recipient)) return fail("Wrong recipient");
  if (message !== signInMessage(accountId, issuedAtOf(message))) return fail("Unexpected message");
  const age = Date.now() - issuedAtOf(message);
  if (!(age >= -60e3 && age < 10 * 60e3)) return fail("Sign-in message expired");
  const n = unb64(nonce ?? "");
  if (n.length !== 32) return fail("Bad nonce");
  if (!(await verifySignature({ publicKey, signature, message, nonce: n, recipient }))) return fail("Signature does not verify", 401);
  const network = b.network === "mainnet" ? "mainnet" : "testnet";
  const key = await rpc(rpcFor(env, network), { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKey }).catch(() => null);
  if (!key || key.permission !== "FullAccess") return fail("That key is not a full-access key of this account", 401);
  const nhex = hex(n);
  const used = await env.CORNER_DB.prepare("INSERT OR IGNORE INTO nonces (nonce, exp) VALUES (?, ?)").bind(nhex, Date.now() + 15 * 60e3).run();
  if ((used.meta?.changes ?? 0) !== 1) return fail("Nonce already used", 401);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = Date.now() + SESSION_TTL;
  await env.CORNER_DB.batch([
    env.CORNER_DB.prepare("INSERT INTO sessions (token, account, exp) VALUES (?, ?, ?)").bind(token, accountId, exp),
    env.CORNER_DB.prepare("DELETE FROM sessions WHERE exp < ?").bind(Date.now()),
    env.CORNER_DB.prepare("DELETE FROM nonces WHERE exp < ?").bind(Date.now()),
  ]);
  return json({ token, accountId, exp });
}

async function handleCorner(env, req, network, coordinator, id) {
  if (!allowed(env).has(`${network}:${coordinator}`)) return fail("Unknown coordinator", 404);
  const key = `${network}:${coordinator}:${id}`;
  const pub = await publicInfo(env, network, coordinator, id);
  const wallet = await sessionAccount(env, req);
  const viewer = wallet ?? guestOf(req);
  const reveals = Object.fromEntries(pub.revealed);
  if (req.method === "GET") {
    const c = await loadCorner(env, key);
    return json({ state: await masked(c.state, c.salt, pub, viewer), viewer, verified: !!wallet, reveals, launcher: pub.launcher });
  }
  if (req.method !== "POST") return fail("Method not allowed", 405);
  if (throttled(req)) return fail("Slow down a little", 429);
  const { action } = await readBody(req);
  if (!viewer) return fail("Sign in with your wallet or pick a guest name", 401);
  const actor = { id: viewer, kind: wallet ? "wallet" : "guest", verified: !!wallet };
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await loadCorner(env, key);
    let next;
    try { next = applyAction(c.state, actor, action ?? {}, Date.now()); } catch (e) { return fail(e.message, e.status ?? 400); }
    if (await saveCorner(env, key, c, next)) return json({ state: await masked(next, c.salt, pub, viewer), viewer, verified: !!wallet, reveals, launcher: pub.launcher });
  }
  return fail("Busy, try again", 409);
}

/** Corner contributions for an account across every corner on this coordinator (public ones only). */
async function handleRecord(env, req, network, coordinator, account) {
  if (!allowed(env).has(`${network}:${coordinator}`)) return fail("Unknown coordinator", 404);
  const viewer = await sessionAccount(env, req);
  const { results } = await env.CORNER_DB.prepare("SELECT key, state FROM corners WHERE key LIKE ? LIMIT 200").bind(`${network}:${coordinator}:%`).all();
  const out = [];
  for (const r of results ?? []) {
    const st = JSON.parse(r.state);
    if (!st.members.some((m) => m.id === account)) continue;
    const id = Number(r.key.split(":").pop());
    const pub = await publicInfo(env, network, coordinator, id).catch(() => null);
    if (!pub) continue;
    const isPublic = viewer === account || pub.launcher === account || pub.revealed.has(account);
    if (!isPublic) continue; // hidden presalers stay hidden until their wave
    const a = activity(st, account, Date.now(), 3650);
    const missions = st.events.filter((e) => e.actor === account && e.type === "mission").length;
    out.push({ launchId: id, symbol: pub.symbol, points: a.score, wins: a.wins, missions, wave: pub.revealed.get(account) ?? null });
  }
  return json({ account, corners: out });
}

const AI_MODEL = "@cf/meta/llama-3.2-3b-instruct";
async function handleAgent(env, req) {
  if (throttled(req, 30)) return fail("Slow down a little", 429);
  const { q, ctx } = await readBody(req);
  const question = String(q ?? "").slice(0, 400);
  const base = agentAnswer(question, ctx ?? {});
  if (env.CORNER_AI !== "on" || !env.AI || base.kind === "context") return json({ ...base, engine: "retrieval" });
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(env.CORNER_AI_DAILY_CALLS ?? 150), neuronCap = Number(env.CORNER_AI_DAILY_NEURONS ?? 3000);
  const u = await env.CORNER_DB.prepare("SELECT calls, neurons FROM ai_usage WHERE day = ?").bind(day).first();
  if (u && (u.calls >= cap || u.neurons >= neuronCap)) return json({ ...base, engine: "retrieval", note: "daily AI budget used; answering from notes" });
  const notes = retrieve(question, 3);
  const sys = `You are the Cabal Corner agent for a NEAR memecoin launch team on KYP. Answer in under 90 words, plainly. Use ONLY these notes and launch facts; if they don't cover it, say so.\nLaunch: ${JSON.stringify({ symbol: ctx?.symbol, status: ctx?.status, raised: ctx?.raised }).slice(0, 300)}\nNotes:\n${notes.map((n) => `- ${n.title}: ${n.text}`).join("\n")}`;
  try {
    const r = await env.AI.run(AI_MODEL, { messages: [{ role: "system", content: sys }, { role: "user", content: question }], max_tokens: 180 });
    const inTok = r.usage?.prompt_tokens ?? 900, outTok = r.usage?.completion_tokens ?? 180;
    const neurons = (inTok * 4625 + outTok * 30475) / 1e6; // published per-token neuron rates for this model
    await env.CORNER_DB.prepare("INSERT INTO ai_usage (day, calls, neurons) VALUES (?, 1, ?) ON CONFLICT(day) DO UPDATE SET calls = calls + 1, neurons = neurons + ?").bind(day, neurons, neurons).run();
    return json({ text: String(r.response ?? base.text).trim(), sources: notes.map((n) => ({ title: n.title })), kind: "ai", engine: "workers-ai" });
  } catch {
    return json({ ...base, engine: "retrieval" });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      if (!env.CORNER_DB) return fail("Cabal Corner storage is not configured", 503);
      const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // api, corner, ...
      if (p[1] !== "corner") return fail("Not found", 404);
      if (p[2] === "health") return json({ ok: true, ai: env.CORNER_AI === "on" && !!env.AI });
      if (p[2] === "auth" && req.method === "POST") return await handleAuth(env, req);
      if (p[2] === "agent" && req.method === "POST") return await handleAgent(env, req);
      if (p[2] === "record" && p.length === 6 && req.method === "GET") return await handleRecord(env, req, p[3], p[4], p[5]);
      if (p.length === 5 && /^(testnet|mainnet)$/.test(p[2]) && /^\d{1,9}$/.test(p[4])) return await handleCorner(env, req, p[2], p[3], Number(p[4]));
      return fail("Not found", 404);
    } catch (e) {
      return fail(e?.message ?? "Error", e?.status ?? 500);
    }
  },
};
