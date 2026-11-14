// Pure transaction builders + access rules for wallet-signed writes (testable with node --test).
// A "tx" is { receiverId, actions: [{ method, args, gas, deposit }] } with gas/deposit as decimal
// strings (gas in gas units, deposit in yoctoNEAR). wallet.ts turns these into near-js actions.

export const TGAS = 10n ** 12n;
export const ONE_YOCTO = "1";
const NEAR = 10n ** 24n;
const g = (t) => (BigInt(t) * TGAS).toString();
const fc = (method, args, tgas, deposit = "0") => ({ method, args, gas: g(tgas), deposit: String(deposit) });
const MAX_TX_GAS = 1000n * TGAS; // NEAR per-transaction gas limit (1 PGas)

/** Extra NEAR attached to create_launch on top of token_account_deposit, for the launch record's storage. */
export const CREATE_STORAGE_BUFFER = (NEAR / 10n).toString(); // 0.1 NEAR

export function createLaunchTx(coordinator, params, tokenAccountDeposit) {
  const deposit = BigInt(tokenAccountDeposit) + BigInt(CREATE_STORAGE_BUFFER);
  return { receiverId: coordinator, actions: [fc("create_launch", { params }, 300, deposit)] };
}

/** NEAR the launcher must attach to `launch` (mirrors coordinator.pool_near_needed). */
export function launchNearNeeded(cfg) {
  return (
    BigInt(cfg.pool_storage_deposit) + BigInt(cfg.pool_create_deposit) + 2n * BigInt(cfg.liquidity_deposit)
  ).toString();
}

export const launchTx = (coordinator, launchId, nearNeeded) => ({ receiverId: coordinator, actions: [fc("launch", { launch_id: launchId }, 300, nearNeeded)] });
export const resumeLaunchTx = (coordinator, launchId, deposit = "0") => ({ receiverId: coordinator, actions: [fc("resume_launch", { launch_id: launchId }, 1000, deposit)] });
export const cancelLaunchTx = (coordinator, launchId) => ({ receiverId: coordinator, actions: [fc("cancel_launch", { launch_id: launchId }, 30)] });
export const withdrawTx = (coordinator, launchId) => ({ receiverId: coordinator, actions: [fc("withdraw", { launch_id: launchId }, 60)] });
export const revealTx = (coordinator, launchId) => ({ receiverId: coordinator, actions: [fc("reveal_next_wave", { launch_id: launchId }, 30)] });
export const recordTx = (lock, launchId) => ({ receiverId: lock, actions: [fc("record", { launch_id: launchId }, 100)] });
export const qualifyTx = (lock, launchId) => ({ receiverId: lock, actions: [fc("qualify", { launch_id: launchId }, 50)] });
export const claimTx = (lock, launchId) => ({ receiverId: lock, actions: [fc("claim", { launch_id: launchId }, 100)] });
export const setBuybackBpsTx = (coordinator, launchId, bps) => ({ receiverId: coordinator, actions: [fc("set_buyback_bps", { launch_id: launchId, bps }, 30)] });
export const buybackToLockTx = (coordinator, launchId, amount, minOutput) => ({ receiverId: coordinator, actions: [fc("buyback_to_lock", { launch_id: launchId, amount, min_output: minOutput }, 400)] });
export const resumeBuybackTx = (coordinator, launchId) => ({ receiverId: coordinator, actions: [fc("resume_buyback", { launch_id: launchId }, 300)] });
export const collectFeesTx = (coordinator, launchId) => ({ receiverId: coordinator, actions: [fc("collect_fees", { launch_id: launchId }, 300)] });
export const approveBountyTx = (coordinator, launchId, bountyRef, receiver, maxAmount, tokenId) => ({ receiverId: coordinator, actions: [fc("approve_bounty", { launch_id: launchId, bounty_ref: bountyRef, receiver_id: receiver, max_amount: maxAmount, token_id: tokenId }, 30)] });
export const payBountyTx = (coordinator, launchId, tokenId, receiver, amount, bountyRef) => ({ receiverId: coordinator, actions: [fc("pay_bounty", { launch_id: launchId, token_id: tokenId, receiver_id: receiver, amount, bounty_ref: bountyRef }, 80)] });
export const approveAndPayBountyTx = (coordinator, launchId, tokenId, receiver, amount, bountyRef) => ({
  receiverId: coordinator,
  actions: [
    fc("approve_bounty", { launch_id: launchId, bounty_ref: bountyRef, receiver_id: receiver, max_amount: amount, token_id: tokenId }, 30),
    fc("pay_bounty", { launch_id: launchId, token_id: tokenId, receiver_id: receiver, amount, bounty_ref: bountyRef }, 80),
  ],
});

/**
 * One transaction to the quote token (wNEAR) that does whatever is missing, then deposits:
 *   1. storage_deposit for the signer if not registered on wNEAR,
 *   2. storage_deposit for the coordinator if it is not registered (normally done at deploy),
 *   3. near_deposit to wrap the shortfall if the signer's wNEAR balance is below `amount`,
 *   4. ft_transfer_call(coordinator, amount, msg) with 1 yocto.
 * `state` = { signerRegistered, coordinatorRegistered, wnearBalance, storageMin }.
 */
export function depositTx({ quote, coordinator, signer, amount, msg, state }) {
  const amt = BigInt(amount);
  if (amt <= 0n) throw new Error("amount must be > 0");
  const actions = [];
  if (!state.signerRegistered) actions.push(fc("storage_deposit", { account_id: signer, registration_only: true }, 30, state.storageMin));
  if (!state.coordinatorRegistered) actions.push(fc("storage_deposit", { account_id: coordinator, registration_only: true }, 30, state.storageMin));
  const short = amt - BigInt(state.wnearBalance ?? "0");
  if (short > 0n) actions.push(fc("near_deposit", {}, 10, short));
  actions.push(fc("ft_transfer_call", { receiver_id: coordinator, amount: amt.toString(), msg }, 150, ONE_YOCTO));
  return { receiverId: quote, actions };
}

export const depositMsg = (kind, launchId, salt) => JSON.stringify({ [kind]: { launch_id: launchId, salt } });

export function totalGas(tx) {
  return tx.actions.reduce((a, x) => a + BigInt(x.gas), 0n);
}
export const fitsInOneTx = (tx) => totalGas(tx) <= MAX_TX_GAS;

// ---------------------------------------------------------------- access (UI gating only;
// the contracts enforce the same rules)

export const isLauncher = (account, launch) => Boolean(account && launch && account === launch.launcher);

/** Allowlist is hashed: a wallet "is on the list" when hash(account:code) matches a slot. */
export function depositGate({ account, slot, launch, now }) {
  if (!account) return { ok: false, reason: "connect" };
  if (!slot) return { ok: false, reason: "not-allowlisted" };
  const reserved = typeof slot.kind === "object";
  if (reserved) {
    if (launch.status !== "Live") return { ok: false, reason: "reserved-after-launch" };
    if (slot.filled) return { ok: false, reason: "filled" };
    return { ok: true, reason: "buy-reserved" };
  }
  if (launch.status !== "Open" || now < launch.sale_start || now >= launch.sale_end) return { ok: false, reason: "closed" };
  return { ok: true, reason: "deposit" };
}

export function canWithdraw({ account, launch, now, deposited }) {
  if (!account || !deposited) return false;
  return launch.status === "Cancelled" || (launch.status === "Open" && now >= launch.sale_end);
}

export function canLaunch({ account, launch, now }) {
  return isLauncher(account, launch) && launch.status === "Open" && now < launch.sale_end && BigInt(launch.total_raised) > 0n && BigInt(launch.total_raised) >= BigInt(launch.min_raise);
}

/** Parse the redirect a browser wallet (e.g. MyNearWallet) sends back after signing. */
export function parseWalletRedirect(search) {
  const p = new URLSearchParams(search);
  const hashes = (p.get("transactionHashes") || "").split(",").filter(Boolean);
  const errorCode = p.get("errorCode");
  const errorMessage = p.get("errorMessage");
  if (!hashes.length && !errorCode) return null;
  for (const k of ["transactionHashes", "errorCode", "errorMessage", "account_id", "public_key", "all_keys"]) p.delete(k);
  const rest = p.toString();
  return { hashes, error: errorCode ? decodeURIComponent(errorMessage || errorCode) : null, cleanSearch: rest ? `?${rest}` : "" };
}

export { explorerTxUrl as explorerTx } from "./network.mjs";
