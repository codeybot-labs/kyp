import { setNetwork } from "../lib/config";

export default function NetworkSwitch(p: { current: "testnet" | "mainnet" }) {
  return (
    <label class="row" style={{ gap: "6px", "align-items": "center" }}>
      <span class="sub" style={{ "font-size": "12px" }}>Network</span>
      <select class="btn sm ghost" value={p.current} onChange={(e) => setNetwork(e.currentTarget.value as "testnet" | "mainnet")}>
        <option value="testnet">Testnet</option>
        <option value="mainnet">Mainnet</option>
      </select>
    </label>
  );
}
