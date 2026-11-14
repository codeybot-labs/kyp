import { cliCall } from "./near";
import { CONFIG, KYP_ENABLED, NETWORK } from "./config";
import type { LaunchParams } from "./model";
import type { Tx } from "./wallet";

export interface Platform {
  id: "kyp" | "nearly" | "justhoot";
  label: string;
  website: string;
  color: string;
  enabled: boolean;
}

export const PLATFORMS: Platform[] = [
  { id: "kyp", label: "Know Your Cabal", website: "https://kycabal.fun", color: "#4df0bb", enabled: KYP_ENABLED },
  { id: "nearly", label: "NEARly", website: "https://nearly.trade", color: "#ffd23f", enabled: NETWORK === "mainnet" },
  { id: "justhoot", label: "JustHoot", website: "https://justhoot.fun", color: "#ff6fa5", enabled: NETWORK === "mainnet" },
];

export function externalCommands(
  params: LaunchParams,
  signer: string,
  selected: Platform["id"][]
): { platform: Platform; commands: { label: string; cmd: string }[]; note: string }[] {
  const out: { platform: Platform; commands: { label: string; cmd: string }[]; note: string }[] = [];
  const quote = CONFIG.quote || "wrap.near";

  if (selected.includes("nearly")) {
    const p = PLATFORMS.find((x) => x.id === "nearly")!;
    // Nearly's creator_share_bps default is the current factory config value (6000 at time of writing).
    const args = {
      name: params.name,
      symbol: params.symbol.toUpperCase(),
      description: params.description || "",
      links: {},
      icon: params.icon || "",
      quote_token_id: quote,
      fee_mode: "creator",
      creator_share_bps: 6000,
      fee_to: null,
      tax: null,
    };
    out.push({
      platform: p,
      commands: [{
        label: "Create the NEARly token + pool",
        cmd: cliCall("nearlytrade.near", "launch", args, { signer, deposit: "0.3 NEAR", gas: "300 Tgas" }),
      }],
      note: "Creates a separate token/pool on nearly.trade using the same name/symbol/icon. Extra deposit is refunded.",
    });
  }

  if (selected.includes("justhoot")) {
    const p = PLATFORMS.find((x) => x.id === "justhoot")!;
    // The front-end transaction we inspected called storage_deposit(registration_only: true) before launch_meme.
    out.push({
      platform: p,
      commands: [
        {
          label: "Register storage on JustHoot",
          cmd: cliCall("v2-launchpad.justhoot.near", "storage_deposit", { registration_only: true }, { signer, deposit: "0.00217 NEAR", gas: "30 Tgas" }),
        },
        {
          label: "Create the JustHoot meme + pool",
          cmd: cliCall("v2-launchpad.justhoot.near", "launch_meme", {
            args: {
              icon: params.icon || "",
              name: params.name,
              shares: { burn_bps: 0, holders_bps: 0, token_owner_bps: 10000 },
              symbol: params.symbol.toUpperCase(),
              reference: null,
              quote_token_id: quote,
              reference_hash: null,
              dev_buy_quote_max: null,
              transfer_fee_pips: 0,
            },
          }, { signer, deposit: "0.11 NEAR", gas: "300 Tgas" }),
        },
      ],
      note: "Creates a separate token/pool on justhoot.fun. Run storage_deposit first, then launch_meme.",
    });
  }

  return out;
}

const TGAS = 1_000_000_000_000n;
const NEAR = 1_000_000_000_000_000_000_000_000n;
const gas = (t: number) => (BigInt(t) * TGAS).toString();
const near = (n: number) => (BigInt(Math.round(n * 1e6)) * NEAR / 1_000_000n).toString();

export function externalSignTxs(
  params: LaunchParams,
  selected: Platform["id"][]
): Tx[] {
  if (NETWORK !== "mainnet") return [];
  const quote = CONFIG.quote || "wrap.near";
  const txs: Tx[] = [];

  if (selected.includes("nearly")) {
    txs.push({
      receiverId: "nearlytrade.near",
      actions: [{
        method: "launch",
        args: {
          name: params.name,
          symbol: params.symbol.toUpperCase(),
          description: params.description || "",
          links: {},
          icon: params.icon || null,
          quote_token_id: quote,
          fee_mode: "creator",
          creator_share_bps: 6000,
          fee_to: null,
          tax: null,
        },
        gas: gas(300),
        deposit: near(0.3),
      }],
    });
  }

  if (selected.includes("justhoot")) {
    txs.push({
      receiverId: "v2-launchpad.justhoot.near",
      actions: [
        {
          method: "storage_deposit",
          args: { registration_only: true },
          gas: gas(30),
          deposit: near(0.00217),
        },
        {
          method: "launch_meme",
          args: {
            args: {
              icon: params.icon || "",
              name: params.name,
              shares: { burn_bps: 0, holders_bps: 0, token_owner_bps: 10000 },
              symbol: params.symbol.toUpperCase(),
              reference: null,
              quote_token_id: quote,
              reference_hash: null,
              dev_buy_quote_max: null,
              transfer_fee_pips: 0,
            },
          },
          gas: gas(300),
          deposit: near(0.11),
        },
      ],
    });
  }

  return txs;
}
