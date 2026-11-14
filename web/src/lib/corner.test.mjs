import test from "node:test";
import assert from "node:assert/strict";
import { teamMix, missionsFor, bountyStatus, toggleVote, agentAnswer, cleanSkills, SKILLS, applyAction, emptyState, activity, maskState, majority } from "./corner.mjs";
import { retrieve, KB } from "./corner-kb.mjs";
import { payloadBytes, verifySignature, signInMessage, issuedAtOf, b64, base58Decode } from "./nep413.mjs";

const A = { id: "alice.testnet", kind: "wallet", verified: true };
const B = { id: "bob.testnet", kind: "wallet", verified: true };
const C = { id: "guest:carol", kind: "guest", verified: false };
const T0 = Date.UTC(2026, 10, 14, 10);
const H = 3600e3, D = 86400e3;

function team() {
  let s = emptyState();
  s = applyAction(s, A, { type: "join", skills: ["dev"] }, T0);
  s = applyAction(s, B, { type: "join", skills: ["creator"] }, T0);
  s = applyAction(s, C, { type: "join" }, T0);
  return s;
}

test("cleanSkills drops unknowns and dedupes in canonical order", () => {
  assert.deepEqual(cleanSkills(["designer", "dev", "dev", "wizard"]), ["dev", "designer"]);
  assert.deepEqual(cleanSkills(undefined), []);
});

test("teamMix flags missing and thin skills, ready when covered", () => {
  const mix = teamMix([{ skills: ["dev", "creator"] }, { skills: ["community"] }]);
  assert.ok(mix.missing.includes("designer"));
  assert.ok(mix.thin.includes("creator") && mix.thin.includes("community"));
  assert.equal(mix.ready, false);
  const all = SKILLS.map((s) => s.id);
  assert.equal(teamMix([{ skills: all }, { skills: all }]).ready, true);
});

test("missionsFor is stable per day, matches skills, fills the symbol", () => {
  const a = missionsFor({ account: "alice.testnet", skills: ["designer", "dev"], symbol: "KIP", day: "2026-11-14" });
  assert.deepEqual(a, missionsFor({ account: "alice.testnet", skills: ["designer", "dev"], symbol: "KIP", day: "2026-11-14" }));
  assert.equal(a.length, 3);
  assert.ok(a.every((m) => ["designer", "dev"].includes(m.skill) && !m.text.includes("{sym}")));
  assert.ok(missionsFor({ account: "x", skills: [], day: "2026-11-14" }).every((x) => x.skill === "community"));
});

test("majority and votes", () => {
  assert.equal(majority(1), 2);
  assert.equal(majority(3), 2);
  assert.equal(majority(4), 3);
  let b = toggleVote({ votes: [] }, "a");
  b = toggleVote(b, "b");
  assert.equal(bountyStatus(b, 3).agreed, true);
  assert.equal(bountyStatus(toggleVote(b, "b"), 3).votes, 1);
});

test("reducer: join, skills, missions, must join first", () => {
  let s = team();
  assert.equal(s.members.length, 3);
  assert.throws(() => applyAction(s, { id: "zed.testnet", kind: "wallet" }, { type: "vote", id: "x" }, T0), /Join/);
  s = applyAction(s, A, { type: "skills", skills: ["dev", "designer", "bogus"] }, T0);
  assert.deepEqual(s.members[0].skills, ["dev", "designer"]);
  s = applyAction(s, A, { type: "mission", mission: "2026-11-14:dev-1", text: "poke" }, T0);
  assert.deepEqual(s.done[A.id], ["2026-11-14:dev-1"]);
  s = applyAction(s, A, { type: "mission", mission: "2026-11-14:dev-1" }, T0);
  assert.deepEqual(s.done[A.id], []);
  assert.throws(() => applyAction(s, A, { type: "mission", mission: "<script>" }, T0), /Bad mission/);
});

test("reducer: bounty lifecycle propose → agree → claim → deliver → approve", () => {
  let s = team();
  s = applyAction(s, A, { type: "propose", kind: "bounty", title: "Sticker pack", skill: "designer", reward: "15%" }, T0);
  const id = s.bounties[0].id;
  assert.equal(s.bounties[0].status, "proposed");
  assert.throws(() => applyAction(s, B, { type: "claim", id }, T0), /agreed/);
  s = applyAction(s, B, { type: "vote", id }, T0 + 1);
  assert.equal(s.bounties[0].status, "agreed");
  s = applyAction(s, C, { type: "claim", id }, T0 + 2);
  assert.throws(() => applyAction(s, A, { type: "submit", id, link: "https://x.y" }, T0), /claimant/);
  assert.throws(() => applyAction(s, C, { type: "submit", id, link: "javascript:alert(1)" }, T0), /link/);
  s = applyAction(s, C, { type: "submit", id, link: "https://example.com/stickers" }, T0 + 3);
  assert.throws(() => applyAction(s, C, { type: "approve", id }, T0), /own/);
  s = applyAction(s, A, { type: "approve", id }, T0 + 4);
  s = applyAction(s, B, { type: "approve", id }, T0 + 5);
  assert.equal(s.bounties[0].status, "done");
  assert.equal(activity(s, C.id, T0 + H).wins, 1);
});

test("reducer: competition entries, one vote each, close picks winner", () => {
  let s = team();
  s = applyAction(s, A, { type: "propose", kind: "competition", title: "Best meme" }, T0);
  const id = s.bounties[0].id;
  s = applyAction(s, B, { type: "vote", id }, T0);
  assert.equal(s.bounties[0].status, "open");
  s = applyAction(s, B, { type: "enter", id, link: "https://example.com/b" }, T0 + 1);
  s = applyAction(s, C, { type: "enter", id, link: "https://example.com/c" }, T0 + 2);
  assert.throws(() => applyAction(s, B, { type: "enter", id, link: "https://example.com/b2" }, T0), /One entry/);
  const [eb, ec] = s.bounties[0].entries;
  s = applyAction(s, A, { type: "voteEntry", id, entry: eb.id }, T0 + 3);
  s = applyAction(s, A, { type: "voteEntry", id, entry: ec.id }, T0 + 4); // moves the vote
  assert.equal(s.bounties[0].entries[0].votes.length, 0);
  assert.equal(s.bounties[0].entries[1].votes.length, 1);
  assert.throws(() => applyAction(s, B, { type: "close", id }, T0), /proposer/);
  s = applyAction(s, A, { type: "close", id }, T0 + 5);
  assert.equal(s.bounties[0].winner, ec.id);
  assert.equal(activity(s, C.id, T0 + H).wins, 1);
});

test("no passengers: activity score and passenger flag", () => {
  let s = team();
  s = applyAction(s, A, { type: "mission", mission: "2026-11-14:dev-0" }, T0 + H);
  s = applyAction(s, A, { type: "propose", title: "Raid list" }, T0 + 2 * H);
  const a = activity(s, A.id, T0 + 3 * H);
  assert.equal(a.score, 3);
  assert.equal(a.status, "warming up");
  assert.equal(activity(s, B.id, T0 + 4 * D).status, "passenger");
  assert.notEqual(activity(s, A.id, T0 + 1 * D).status, "passenger");
});

test("built in the open: hidden wallets are aliased everywhere until revealed", () => {
  let s = team();
  s = applyAction(s, A, { type: "propose", kind: "bounty", title: "Banner" }, T0);
  s = applyAction(s, B, { type: "vote", id: s.bounties[0].id }, T0);
  const alias = (id) => `Caballero ${id === A.id ? "AAAA" : "BBBB"}`;
  const m = maskState(s, (id) => id === B.id, alias);
  const text = JSON.stringify(m);
  assert.ok(!text.includes(A.id), "alice must not leak");
  assert.ok(text.includes(B.id));
  assert.ok(text.includes("guest:carol"));
  assert.equal(m.bounties[0].by, "Caballero AAAA");
  assert.ok(m.members.find((x) => x.id === "Caballero AAAA").hidden);
});

test("caps and validation", () => {
  let s = team();
  assert.throws(() => applyAction(s, A, { type: "propose", title: "x" }, T0), /title/);
  assert.throws(() => applyAction(s, A, { type: "nope" }, T0), /Unknown/);
  s = applyAction(s, A, { type: "propose", title: "y".repeat(500) }, T0);
  assert.equal(s.bounties[0].title.length, 80);
});

test("knowledge retrieval finds the right notes", () => {
  assert.ok(KB.length >= 20);
  assert.equal(retrieve("how does the twap unlock work")[0].id, "twap");
  assert.equal(retrieve("what is wNEAR")[0].id, "wnear");
  assert.equal(retrieve("how do bounties get paid")[0].id, "fees");
  assert.equal(retrieve("how do fees flow")[0].id, "flywheel");
  assert.deepEqual(retrieve(""), []);
});

test("agent answers from launch context and the knowledge set", () => {
  const mix = teamMix([{ skills: ["dev"] }]);
  assert.match(agentAnswer("what skills are missing?", { symbol: "KIP", mix, rosterSize: 1 }).text, /Designer/);
  assert.match(agentAnswer("who are the passengers?", { passengers: ["bob"] }).text, /bob/);
  assert.match(agentAnswer("how does the twap unlock work").text, /time-weighted/);
  assert.equal(agentAnswer("qwertyuiop zzz").kind, "fallback");
});

test("NEP-413: payload layout and signature verification", async () => {
  const nonce = new Uint8Array(32).fill(7);
  const bytes = payloadBytes({ message: "hi", nonce, recipient: "kycabal.fun" });
  assert.deepEqual([...bytes.slice(0, 4)], [0x9d, 0x01, 0x00, 0x80]); // 2^31 + 413, little-endian
  assert.equal(bytes.length, 4 + 4 + 2 + 32 + 4 + 11 + 1);
  const { KeyPair } = await import("@near-js/crypto");
  const { payloadHash } = await import("./nep413.mjs");
  const kp = KeyPair.fromRandom("ed25519");
  const message = signInMessage("alice.testnet", T0);
  assert.equal(issuedAtOf(message), T0);
  const sig = kp.sign(await payloadHash({ message, nonce, recipient: "kycabal.fun" })).signature;
  const publicKey = kp.getPublicKey().toString();
  assert.equal(await verifySignature({ publicKey, signature: b64(sig), message, nonce, recipient: "kycabal.fun" }), true);
  assert.equal(await verifySignature({ publicKey, signature: b64(sig), message, nonce, recipient: "evil.example" }), false);
  assert.equal(base58Decode(publicKey.slice(8)).length, 32);
});

import { approvalsNeeded } from "./corner.mjs";
test("approvals: majority of the non-deliverers, min 1, so a 2-person roster can finish a bounty", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(approvalsNeeded), [1, 1, 2, 2, 3]);
  let s = emptyState();
  s = applyAction(s, A, { type: "join", skills: ["dev"] }, T0);
  s = applyAction(s, B, { type: "join", skills: ["creator"] }, T0);
  s = applyAction(s, A, { type: "propose", kind: "bounty", title: "Logo", skill: "designer", reward: "5%" }, T0);
  const id = s.bounties[0].id;
  s = applyAction(s, B, { type: "vote", id }, T0 + 1);
  assert.equal(s.bounties[0].status, "agreed");
  s = applyAction(s, B, { type: "claim", id }, T0 + 2);
  s = applyAction(s, B, { type: "submit", id, link: "https://example.com/logo" }, T0 + 3);
  assert.throws(() => applyAction(s, B, { type: "approve", id }, T0 + 4), /own/);
  s = applyAction(s, A, { type: "approve", id }, T0 + 4);
  assert.equal(s.bounties[0].status, "done");
});
