// NEP-413 off-chain message signing helpers (sign-in for Cabal Corner). WebCrypto only, so the
// same code runs in the browser, the Cloudflare Worker and Node tests.
const TAG = 2 ** 31 + 413;
const enc = new TextEncoder();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58Decode(s) {
  const bytes = [0];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) throw new Error("bad base58");
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of s) { if (ch === "1") bytes.push(0); else break; }
  return new Uint8Array(bytes.reverse());
}
export const b64 = (u8) => btoa(String.fromCharCode(...u8));
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");

function u32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function str(s) { const e = enc.encode(s); return [u32(e.length), e]; }

/** Borsh bytes of the NEP-413 payload, prefixed by the 2^31+413 tag. */
export function payloadBytes({ message, nonce, recipient, callbackUrl = null }) {
  if (!(nonce instanceof Uint8Array) || nonce.length !== 32) throw new Error("nonce must be 32 bytes");
  const parts = [u32(TAG), ...str(message), nonce, ...str(recipient), callbackUrl == null ? new Uint8Array([0]) : new Uint8Array([1]), ...(callbackUrl == null ? [] : str(callbackUrl))];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export async function payloadHash(p) { return new Uint8Array(await crypto.subtle.digest("SHA-256", payloadBytes(p))); }

/** Decode a wallet signature (base64 per NEP-413; some wallets return base58). */
export function decodeSignature(sig) {
  const s = String(sig).replace(/^ed25519:/, "");
  try { const u = unb64(s); if (u.length === 64) return u; } catch {}
  const u = base58Decode(s);
  if (u.length !== 64) throw new Error("signature must be 64 bytes");
  return u;
}

/** Verify a NEP-413 signature for an `ed25519:` public key. */
export async function verifySignature({ publicKey, signature, message, nonce, recipient, callbackUrl = null }) {
  if (!String(publicKey).startsWith("ed25519:")) return false;
  const raw = base58Decode(publicKey.slice(8));
  if (raw.length !== 32) return false;
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, decodeSignature(signature), await payloadHash({ message, nonce, recipient, callbackUrl }));
}

/** The sign-in message Cabal Corner asks a wallet to sign. */
export function signInMessage(accountId, issuedAtMs) {
  return `Sign in to Cabal Corner\nAccount: ${accountId}\nIssued: ${new Date(issuedAtMs).toISOString()}\nThis signature only proves you own this account. It cannot move funds.`;
}
export function issuedAtOf(message) {
  const m = /Issued: (\S+)/.exec(message);
  return m ? Date.parse(m[1]) : NaN;
}
