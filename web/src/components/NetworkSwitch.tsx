import { setNetwork } from "../lib/config";

export default function NetworkSwitch(p: { current: "testnet" | "mainnet" }) {
  return (
    <select
      class="btn sm ghost network-switch"
      aria-label="Network"
      value={p.current}
      onChange={(e) => setNetwork(e.currentTarget.value as "testnet" | "mainnet")}
      style={{ display: "inline-block" }}
    >
      <option value="testnet">Testnet</option>
      <option value="mainnet">Mainnet</option>
    </select>
  );
}
