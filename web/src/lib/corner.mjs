// Cabal Corner: pure logic shared by the browser (local mode), the Cloudflare Worker API (synced
// mode) and tests. One reducer applies every action, so local and synced behave the same.
import { retrieve } from "./corner-kb.mjs";

/** Skills a launch team needs. `need` = how many caballeros a healthy launch wants with that skill. */
export const SKILLS = [
  { id: "dev", label: "Dev", emoji: "🛠", need: 1, blurb: "contracts, bots, site fixes" },
  { id: "creator", label: "Creator", emoji: "🎬", need: 2, blurb: "memes, threads, video" },
  { id: "designer", label: "Designer", emoji: "🎨", need: 1, blurb: "logo, banners, stickers" },
  { id: "community", label: "Community", emoji: "📣", need: 2, blurb: "chat, raids, mods" },
  { id: "trader", label: "Trader", emoji: "📈", need: 1, blurb: "liquidity, charts, TWAP watch" },
  { id: "partnerships", label: "Partnerships", emoji: "🤝", need: 1, blurb: "KOLs, collabs, listings" },
];
export const SKILL_IDS = SKILLS.map((s) => s.id);
export const skillById = (id) => SKILLS.find((s) => s.id === id);
export const LIMITS = { members: 300, bounties: 100, entries: 50, events: 400, title: 80, text: 280, link: 200, name: 24 };

export function cleanSkills(skills) {
  const set = new Set((skills ?? []).filter((s) => SKILL_IDS.includes(s)));
  return SKILL_IDS.filter((s) => set.has(s));
}

/** Team mix: caballeros per skill, with gaps flagged. */
export function teamMix(roster) {
  const rows = SKILLS.map((s) => {
    const have = roster.filter((c) => (c.skills ?? []).includes(s.id)).length;
    return { ...s, have, gap: Math.max(0, s.need - have), status: have === 0 ? "missing" : have < s.need ? "thin" : "ok" };
  });
  const covered = rows.filter((r) => r.have > 0).length;
  return {
    rows,
    missing: rows.filter((r) => r.status === "missing").map((r) => r.id),
    thin: rows.filter((r) => r.status === "thin").map((r) => r.id),
    score: Math.round((covered / rows.length) * 100),
    ready: rows.every((r) => r.status === "ok"),
  };
}

export const MISSIONS = {
  dev: [
    "Check the launch's terms page against the on-chain view and flag anything off",
    "Poke the TWAP observer once today (anyone can) so the record stays fresh",
    "Review the token metadata (name, symbol, icon) for {sym}",
    "Write a 5-line explainer of how the milestone lock works for the pinned post",
  ],
  creator: [
    "Post one {sym} meme that explains the locked presale",
    "Draft a 3-post thread: why {sym} presalers can't dump",
    "Clip a 15-second explainer of the milestone unlocks",
    "Reply to 5 NEAR posts with something useful (no shilling)",
  ],
  designer: [
    "Make a launch-day banner for {sym} (1500×500)",
    "Design a sticker pack of 4 for the community chat",
    "Make a milestone ladder graphic for the next unlock target",
    "Tidy the {sym} logo for a 64px avatar",
  ],
  community: [
    "Welcome every new member in chat today",
    "Run a 10-minute Q&A on how the presale lock works",
    "Collect 3 questions holders keep asking and ask the agent",
    "Set up a raid list of 5 NEAR accounts that would like {sym}",
  ],
  trader: [
    "Note the pool's spot vs TWAP FDV twice today",
    "Write the next milestone target in plain words for chat",
    "Check pool liquidity and post a short read-out",
    "Sanity-check the opening FDV against similar NEAR memes",
  ],
  partnerships: [
    "List 3 NEAR projects that could co-host a {sym} AMA",
    "Draft a collab DM to one NEAR community lead and share it here first",
    "Find one listing or tracker {sym} should be on after launch",
    "Shortlist 2 KOLs whose audience fits, with reasons",
  ],
};

export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export const dayKey = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/** Up to `n` missions for one caballero, from their skills, stable for the UTC day. */
export function missionsFor({ account, skills, symbol = "TOKEN", day = dayKey(), n = 3 }) {
  const sk = cleanSkills(skills);
  const use = sk.length ? sk : ["community"];
  const bySkill = use.map((s) => MISSIONS[s].map((t, i) => ({ skill: s, i, t })));
  const total = bySkill.reduce((a, l) => a + l.length, 0);
  const seed = hash(`${account}|${day}`);
  const picked = [], used = new Set();
  for (let k = 0; picked.length < Math.min(n, total) && k < 60; k++) {
    const list = bySkill[k % bySkill.length];
    const m = list[(seed + k * 7) % list.length];
    const id = `${m.skill}-${m.i}`;
    if (used.has(id)) continue;
    used.add(id);
    picked.push({ id: `${day}:${id}`, skill: m.skill, text: m.t.replaceAll("{sym}", `$${symbol}`) });
  }
  return picked;
}

/** Majority of the roster (min 2) agrees a bounty or approves a delivery. */
export function majority(rosterSize) { return Math.max(2, Math.floor(Math.max(1, rosterSize) / 2) + 1); }
/** Approvals a delivery needs: a majority of the caballeros who can approve it (everyone but
 * the deliverer), at least 1, so a 2-person roster can still finish a bounty. */
export function approvalsNeeded(rosterSize) { const eligible = Math.max(1, rosterSize - 1); return Math.max(1, Math.floor(eligible / 2) + 1); }
export function bountyStatus(b, rosterSize) {
  const votes = new Set(b.votes ?? []).size;
  const needed = majority(rosterSize);
  return { votes, needed, agreed: votes >= needed };
}
export function toggleIn(list, id) {
  const v = new Set(list ?? []);
  v.has(id) ? v.delete(id) : v.add(id);
  return [...v];
}
export const toggleVote = (b, account) => ({ ...b, votes: toggleIn(b.votes, account) });

export const emptyState = () => ({ v: 1, members: [], bounties: [], events: [], done: {} });

const clip = (s, n) => String(s ?? "").trim().slice(0, n);
const okLink = (s) => { const t = clip(s, LIMITS.link); return /^https?:\/\/\S+$/i.test(t) ? t : ""; };
function err(m) { const e = new Error(m); e.status = 400; throw e; }

/**
 * Apply one action. `actor` = { id, kind: "wallet"|"guest", verified }. Returns the new state.
 * Throws an Error with a readable message on invalid actions.
 */
export function applyAction(state, actor, a, now = Date.now()) {
  const s = structuredClone(state ?? emptyState());
  if (!actor?.id) err("Join first");
  const me = s.members.find((m) => m.id === actor.id);
  const roster = () => s.members.length || 1;
  const log = (type, text, ref) => {
    s.events.push({ ts: now, actor: actor.id, type, text: clip(text, 140), ref: ref ?? null });
    if (s.events.length > LIMITS.events) s.events.splice(0, s.events.length - LIMITS.events);
    if (me) me.lastActive = now;
  };
  const bounty = () => s.bounties.find((b) => b.id === a.id) ?? err("Bounty not found");
  if (a.type !== "join" && !me) err("Join the roster first");

  switch (a.type) {
    case "join": {
      if (me) return s;
      if (s.members.length >= LIMITS.members) err("Roster is full");
      s.members.push({ id: actor.id, kind: actor.kind, verified: !!actor.verified, skills: cleanSkills(a.skills), joinedAt: now, lastActive: now });
      log("join", "joined the corner");
      return s;
    }
    case "skills": {
      me.skills = cleanSkills(a.skills);
      log("skills", `skills: ${me.skills.join(", ") || "none"}`);
      return s;
    }
    case "mission": {
      const id = clip(a.mission, 60);
      if (!/^\d{4}-\d{2}-\d{2}:[a-z]+-\d+$/.test(id)) err("Bad mission id");
      const done = new Set(s.done[actor.id] ?? []);
      if (done.has(id)) done.delete(id); else { done.add(id); log("mission", clip(a.text, 140) || "finished a mission", id); }
      // keep 14 days of mission history per caballero
      const cutoff = dayKey(now - 14 * 86400e3);
      s.done[actor.id] = [...done].filter((x) => x.slice(0, 10) >= cutoff);
      return s;
    }
    case "propose": {
      const title = clip(a.title, LIMITS.title);
      if (title.length < 3) err("Give it a title");
      if (s.bounties.length >= LIMITS.bounties) err("Too many bounties; close some first");
      const kind = a.kind === "competition" ? "competition" : "bounty";
      const b = {
        id: `b${now.toString(36)}${hash(actor.id + title).toString(36).slice(0, 4)}`, kind, title,
        details: clip(a.details, LIMITS.text), skill: SKILL_IDS.includes(a.skill) ? a.skill : "community",
        reward: clip(a.reward, 60) || "to be agreed", by: actor.id, votes: [actor.id], createdAt: now,
        status: "proposed", claimant: null, submission: null, approvals: [], entries: [], winner: null, nearn_url: null,
      };
      s.bounties.unshift(b);
      log("propose", `proposed ${kind} "${title}"`, b.id);
      return s;
    }
    case "vote": {
      const b = bounty();
      if (b.status !== "proposed") err("Voting is closed for this one");
      b.votes = toggleIn(b.votes, actor.id);
      if (bountyStatus(b, roster()).agreed) { b.status = b.kind === "competition" ? "open" : "agreed"; log("agreed", `"${b.title}" agreed by the caballeros`, b.id); }
      else log("vote", `voted on "${b.title}"`, b.id);
      return s;
    }
    case "claim": {
      const b = bounty();
      if (b.kind !== "bounty" || b.status !== "agreed") err("Only agreed bounties can be claimed");
      b.claimant = actor.id; b.status = "claimed";
      log("claim", `took on "${b.title}"`, b.id);
      return s;
    }
    case "submit": {
      const b = bounty();
      if (b.kind !== "bounty" || b.claimant !== actor.id || !["claimed", "submitted"].includes(b.status)) err("Only the claimant can submit");
      const link = okLink(a.link);
      if (!link) err("Add a link (https://…) to the work");
      b.submission = { link, note: clip(a.note, LIMITS.text), at: now }; b.status = "submitted"; b.approvals = [];
      log("submit", `delivered "${b.title}"`, b.id);
      return s;
    }
    case "approve": {
      const b = bounty();
      if (b.status !== "submitted") err("Nothing to approve yet");
      if (b.claimant === actor.id) err("You can't approve your own delivery");
      b.approvals = toggleIn(b.approvals, actor.id);
      if (b.approvals.length >= approvalsNeeded(roster())) { b.status = "done"; log("done", `"${b.title}" approved, reward due from the fee pool`, b.id); }
      else log("approve", `approved "${b.title}"`, b.id);
      return s;
    }
    case "enter": {
      const b = bounty();
      if (b.kind !== "competition" || b.status !== "open") err("This competition isn't open");
      if (b.entries.length >= LIMITS.entries) err("Entries are full");
      if (b.entries.some((e) => e.by === actor.id)) err("One entry each");
      const link = okLink(a.link);
      if (!link) err("Add a link (https://…) to your entry");
      b.entries.push({ id: `e${now.toString(36)}`, by: actor.id, link, note: clip(a.note, LIMITS.text), votes: [], at: now });
      log("enter", `entered "${b.title}"`, b.id);
      return s;
    }
    case "voteEntry": {
      const b = bounty();
      if (b.kind !== "competition" || b.status !== "open") err("Voting is closed");
      const e = b.entries.find((x) => x.id === a.entry) ?? err("Entry not found");
      if (e.by === actor.id) err("You can't vote for your own entry");
      for (const x of b.entries) if (x !== e) x.votes = x.votes.filter((v) => v !== actor.id); // one vote per competition
      e.votes = toggleIn(e.votes, actor.id);
      log("vote", `voted in "${b.title}"`, b.id);
      return s;
    }
    case "close": {
      const b = bounty();
      if (b.kind !== "competition" || b.status !== "open") err("Not an open competition");
      if (b.by !== actor.id) err("Only the proposer can close it");
      const top = [...b.entries].sort((x, y) => y.votes.length - x.votes.length || x.at - y.at)[0];
      b.status = "done"; b.winner = top ? top.id : null;
      log("done", top ? `"${b.title}" closed, winner picked by votes` : `"${b.title}" closed with no entries`, b.id);
      return s;
    }
    case "link_nearn": {
      const b = bounty();
      const link = okLink(a.url ?? a.link);
      if (!link) err("Add the NEARN listing URL (https://…)");
      try {
        const u = new URL(link);
        if (!/^([a-z0-9-]+\.)?nearn\.io$/i.test(u.hostname)) err("That doesn't look like a nearn.io link");
      } catch { err("That doesn't look like a nearn.io link"); }
      b.nearn_url = link;
      log("nearn", `linked NEARN listing for "${b.title}"`, b.id);
      return s;
    }
    default: err("Unknown action");
  }
}

/** Points for activity over the last `days` days, and the no-passengers status. */
export const POINTS = { mission: 1, vote: 1, approve: 1, propose: 2, claim: 1, enter: 2, submit: 3, skills: 0, join: 0, agreed: 0, done: 0 };
export function activity(state, id, now = Date.now(), days = 7) {
  const since = now - days * 86400e3;
  const ev = (state.events ?? []).filter((e) => e.actor === id && e.ts >= since);
  let score = ev.reduce((a, e) => a + (POINTS[e.type] ?? 0), 0);
  const wins = (state.bounties ?? []).filter((b) => b.status === "done" && ((b.kind === "bounty" && b.claimant === id) || (b.kind === "competition" && b.entries.find((e) => e.id === b.winner)?.by === id))).length;
  score += wins * 5;
  const m = (state.members ?? []).find((x) => x.id === id);
  const last = Math.max(m?.lastActive ?? 0, ...ev.map((e) => (POINTS[e.type] ? e.ts : 0)));
  const quietDays = last ? Math.floor((now - last) / 86400e3) : Infinity;
  const tenure = m ? (now - m.joinedAt) / 86400e3 : 0;
  const status = quietDays >= 3 && tenure >= 3 ? "passenger" : score >= 5 ? "active" : score > 0 || quietDays < 1 ? "warming up" : "quiet";
  return { score, wins, quietDays: Number.isFinite(quietDays) ? quietDays : null, status };
}

/**
 * Built in the open: replace every hidden wallet id with an alias until the chain reveals it.
 * `isPublic(id)` decides; `alias(id)` returns the stable alias. Guests and samples stay as-is.
 */
export function maskState(state, isPublic, alias) {
  const kinds = new Map((state.members ?? []).map((m) => [m.id, m.kind]));
  const m = (id) => (id && kinds.get(id) === "wallet" && !isPublic(id) ? alias(id) : id);
  return {
    ...state,
    members: state.members.map((x) => ({ ...x, id: m(x.id), hidden: m(x.id) !== x.id })),
    bounties: state.bounties.map((b) => ({ ...b, by: m(b.by), claimant: m(b.claimant), votes: b.votes.map(m), approvals: b.approvals.map(m), entries: b.entries.map((e) => ({ ...e, by: m(e.by), votes: e.votes.map(m) })) })),
    events: state.events.map((e) => ({ ...e, actor: m(e.actor) })),
    done: Object.fromEntries(Object.entries(state.done ?? {}).map(([k, v]) => [m(k), v])),
  };
}
export const isAlias = (id) => /^Caballero [0-9A-F]{4}$/.test(id ?? "");

/**
 * Agent: answer from this launch's context first, then the curated NEAR knowledge set.
 * Returns { text, sources: [{title}], kind }.
 */
export function agentAnswer(q, ctx = {}) {
  const s = String(q ?? "").toLowerCase().trim();
  const sym = ctx.symbol ? `$${ctx.symbol}` : "the token";
  if (!s) return { text: "Ask about the team mix, missions, bounties, passengers, or anything NEAR (tokens, wNEAR, RHEA pools, TWAP unlocks, wallets).", sources: [], kind: "help" };
  const lbl = (ids) => ids.map((id) => skillById(id)?.label ?? id).join(", ");
  if (ctx.mix && /(missing|gap|skill|team mix|mix|who should|need more|hire|invite)/.test(s)) {
    if (ctx.mix.ready) return { text: `The team mix covers every skill for ${sym} (${ctx.rosterSize ?? 0} caballeros). Next: make sure each skill has someone on today's missions.`, sources: [{ title: "This launch's roster" }], kind: "context" };
    const parts = [];
    if (ctx.mix.missing.length) parts.push(`missing: ${lbl(ctx.mix.missing)}`);
    if (ctx.mix.thin.length) parts.push(`thin: ${lbl(ctx.mix.thin)}`);
    return { text: `Team mix for ${sym} is ${ctx.mix.score}% covered (${parts.join("; ")}). Invite a caballero with those skills, or have someone who can cover it add the skill to their profile.`, sources: [{ title: "This launch's roster" }], kind: "context" };
  }
  if (ctx.passengers && /(passenger|inactive|who is quiet|slacking|active)/.test(s)) {
    const p = ctx.passengers;
    return { text: p.length ? `${p.length} caballero${p.length === 1 ? " is" : "s are"} flagged as passengers (3+ quiet days): ${p.slice(0, 5).join(", ")}. A nudge with one small mission usually works.` : "No passengers right now. Everyone has done something in the last 3 days.", sources: [{ title: "Activity log" }], kind: "context" };
  }
  if (ctx.status && /(status|launched|when is|is it live|is it open|raise|raised)/.test(s) && !/twap|milestone/.test(s)) {
    return { text: `${sym} is "${ctx.status}" on-chain${ctx.raised ? `, ${ctx.raised} raised` : ""}. The Status tab has the window, raise and launch steps.`, sources: [{ title: "KYP coordinator (live view)" }], kind: "context" };
  }
  if (ctx.bounties?.length && /(bount|competition|prize|reward)/.test(s) && !/how|paid|work/.test(s)) {
    const open = ctx.bounties.filter((b) => b.status !== "done");
    return { text: `${open.length} open: ${open.slice(0, 4).map((b) => `"${b.title}" (${b.status})`).join(", ") || "none"}. Proposals need a majority of caballeros to agree; deliveries need a majority to approve.`, sources: [{ title: "This launch's bounties" }], kind: "context" };
  }
  const hits = retrieve(s, 2);
  if (hits.length) return { text: hits[0].text + (hits[1] && hits[1].score > hits[0].score * 0.6 ? `\n\nAlso: ${hits[1].text}` : ""), sources: hits.map((h) => ({ title: h.title })), kind: "knowledge" };
  return { text: "That isn't in my NEAR knowledge set yet. Try tokens, wNEAR, storage, gas, RHEA pools, TWAP milestones, reveal waves, wallets, raids, or your team mix.", sources: [], kind: "fallback" };
}
