// End-to-end check of the Cabal Corner API against a running Worker (wrangler dev or a preview).
// Creates a throwaway testnet account via the public testnet faucet (no real funds), signs the
// NEP-413 sign-in message with it, and drives the corner as that wallet plus a guest.
//   BASE=http://127.0.0.1:8787 node tests/corner.api.e2e.mjs
import assert from "node:assert/strict";
import { generateTestWallet } from "../src/lib/testwallet.mjs";
import { signInMessage, payloadHash, b64 } from "../src/lib/nep413.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const COORD = process.env.COORD ?? "kyp-sushmit-dcl.testnet";
const LAUNCH = Number(process.env.LAUNCH ?? 1);
const host = new URL(BASE).host;
const corner = `${BASE}/api/corner/testnet/${COORD}/${LAUNCH}`;
const j = async (r) => ({ status: r.status, body: await r.json() });

const health = await j(await fetch(`${BASE}/api/corner/health`));
assert.equal(health.body.ok, true);

const w = await generateTestWallet({ network: "testnet", label: "corner" });
await new Promise((r) => setTimeout(r, 4000)); // let the account land
const { KeyPair } = await import("@near-js/crypto");
const kp = KeyPair.fromString(w.secretKey);
const nonce = crypto.getRandomValues(new Uint8Array(32));
const message = signInMessage(w.accountId, Date.now());
const sig = kp.sign(await payloadHash({ message, nonce, recipient: host })).signature;
const auth = { accountId: w.accountId, publicKey: kp.getPublicKey().toString(), signature: b64(sig), message, nonce: b64(nonce), recipient: host, network: "testnet" };

const bad = await j(await fetch(`${BASE}/api/corner/auth`, { method: "POST", body: JSON.stringify({ ...auth, recipient: "evil.example" }) }));
assert.equal(bad.status, 400);
const ok = await j(await fetch(`${BASE}/api/corner/auth`, { method: "POST", body: JSON.stringify(auth) }));
assert.equal(ok.status, 200, JSON.stringify(ok.body));
const replay = await j(await fetch(`${BASE}/api/corner/auth`, { method: "POST", body: JSON.stringify(auth) }));
assert.equal(replay.status, 401, "nonce replay must fail");
const W = { authorization: `Bearer ${ok.body.token}` };
const G = { "x-corner-guest": "e2eguest" };
const post = async (h, action) => j(await fetch(corner, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify({ action }) }));

let r = await post(W, { type: "join", skills: ["dev", "designer"] });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.verified, true);
assert.ok(r.body.state.members.some((m) => m.id === w.accountId), "wallet sees itself");
r = await post(W, { type: "propose", kind: "bounty", title: "E2E sticker pack", skill: "designer", reward: "10%" });
const id = r.body.state.bounties[0].id;
r = await post(G, { type: "join", skills: ["community"] });
assert.equal(r.status, 200);
// guest view: the wallet isn't a revealed presaler, so it must be an alias
assert.ok(!JSON.stringify(r.body.state).includes(w.accountId), "hidden wallet leaked to guest");
assert.ok(r.body.state.members.some((m) => /^Caballero [0-9A-F]{4}$/.test(m.id)));
r = await post(G, { type: "vote", id });
assert.equal(r.status, 200);
const st = r.body.state.bounties.find((b) => b.id === id).status;
console.log("bounty status after guest vote:", st);
r = await post({ authorization: "Bearer " + "0".repeat(64) }, { type: "vote", id });
assert.equal(r.status, 401, "bad token acts as nobody");
r = await post(W, { type: "submit", id, link: "javascript:alert(1)" });
assert.equal(r.status, 400);
const big = await fetch(corner, { method: "POST", headers: G, body: JSON.stringify({ action: { type: "propose", title: "x".repeat(5000) } }) });
assert.equal(big.status, 413);
const rec = await j(await fetch(`${BASE}/api/corner/record/testnet/${COORD}/${w.accountId}`));
assert.deepEqual(rec.body.corners, [], "hidden caballero's corner work stays off the public record");
const recSelf = await j(await fetch(`${BASE}/api/corner/record/testnet/${COORD}/${w.accountId}`, { headers: W }));
assert.equal(recSelf.body.corners.length, 1);
const agent = await j(await fetch(`${BASE}/api/corner/agent`, { method: "POST", body: JSON.stringify({ q: "how do TWAP unlocks work?" }) }));
assert.match(agent.body.text, /time-weighted/);
console.log("corner API e2e: all checks passed for", w.accountId.replace(/^(.{6}).*/, "$1…"), "engine:", agent.body.engine);
