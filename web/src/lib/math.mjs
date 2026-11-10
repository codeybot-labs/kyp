// Display-side math mirroring contracts/common (floats are fine for UI; the chain uses integers).

export const NEAR_DECIMALS = 24;
export const TOKEN_DECIMALS = 18;
export const DEFAULT_SUPPLY = 10n ** 27n; // 1B x 18 decimals

/** Raw bigint/string -> number of whole units. */
export function units(raw, decimals) {
  const b = BigInt(raw);
  const d = 10n ** BigInt(decimals);
  const whole = b / d;
  const frac = Number(b % d) / Number(d);
  return Number(whole) + frac;
}

/** Whole units -> raw bigint (supports up to 6 fractional digits). */
export function toRaw(amount, decimals) {
  const [w, f = ""] = String(amount).trim().split(".");
  const frac = (f + "000000").slice(0, 6);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac) * 10n ** BigInt(decimals - 6);
}

/** tokens = quote * supply / fdv (single presale price), floor. */
export function tokensForQuote(quoteRaw, supplyRaw, fdvRaw) {
  return (BigInt(quoteRaw) * BigInt(supplyRaw)) / BigInt(fdvRaw);
}

/** FDV in raw quote units at a DCL point. */
export function fdvAtPoint(point, tokenIsX, supplyRaw) {
  const p = tokenIsX ? point : -point;
  return Math.pow(1.0001, p) * Number(BigInt(supplyRaw));
}

/** Point (DCL orientation) whose FDV equals fdvRaw. */
export function pointForFdv(fdvRaw, supplyRaw, tokenIsX) {
  const p = Math.log(Number(BigInt(fdvRaw)) / Number(BigInt(supplyRaw))) / Math.log(1.0001);
  return Math.floor(tokenIsX ? p : -p);
}

/** Smallest-first reveal waves: rank -> 1-based wave. */
export function waveOf(rank, n, waves) {
  const per = Math.max(1, Math.ceil(n / waves));
  return Math.floor(rank / per) + 1;
}

/** Time-weighted mean point over [now-window, now] (mirrors contracts/common/src/twap.rs). */
export function twapPoint(obs, now, cfg) {
  const start = now - cfg.window_sec;
  let anchor = -1;
  for (let i = obs.length - 1; i >= 0; i--) if (obs[i].ts <= start) { anchor = i; break; }
  if (anchor < 0) return { ok: false, error: "no observation at or before window start yet" };
  const used = obs.slice(anchor);
  if (used.length < cfg.min_observations)
    return { ok: false, error: `too few observations in window: ${used.length}/${cfg.min_observations}` };
  const maxGap = Math.floor(cfg.window_sec / Math.max(1, cfg.min_observations - 1));
  if (now - used[used.length - 1].ts > maxGap) return { ok: false, error: "latest observation is stale; poke record" };
  if (used.some((o) => BigInt(o.liquidity) < BigInt(cfg.min_liquidity)))
    return { ok: false, error: "pool liquidity below minimum in window" };
  let acc = 0;
  used.forEach((o, i) => {
    const from = Math.max(o.ts, start);
    const to = Math.max(i + 1 < used.length ? used[i + 1].ts : now, from);
    acc += o.point * (to - from);
  });
  return { ok: true, avg_point: Math.floor(acc / cfg.window_sec), observations: used.length };
}

const trim = (s) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
export function fmt(n, digits = 2) {
  if (!isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return trim((n / 1e9).toFixed(digits)) + "B";
  if (abs >= 1e6) return trim((n / 1e6).toFixed(digits)) + "M";
  if (abs >= 1e4) return trim((n / 1e3).toFixed(1)) + "k";
  if (abs >= 100) return Math.round(n).toLocaleString("en-US");
  return trim(n.toFixed(digits));
}

export function fmtUsd(n) {
  if (!isFinite(n)) return "—";
  return "$" + fmt(n, n >= 1e6 ? 1 : 2);
}

export async function slotHash(account, salt) {
  const data = new TextEncoder().encode(`${account}:${salt}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomSalt() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
