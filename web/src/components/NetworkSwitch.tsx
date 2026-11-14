import { NETWORK_NAME, setNetwork } from "../lib/config";

const arrow =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E";

export default function NetworkSwitch() {
  return (
    <select
      class="dd-btn network-switch"
      aria-label="Network"
      value={NETWORK_NAME === "Mainnet" ? "mainnet" : "testnet"}
      onChange={(e) => setNetwork(e.currentTarget.value as "testnet" | "mainnet")}
      style={{ display: "inline-block", width: "auto", "padding-right": "30px", "background-image": `url("${arrow}")`, "background-repeat": "no-repeat", "background-position": "right 12px center", cursor: "pointer" }}
    >
      <option value="testnet">Testnet</option>
      <option value="mainnet">Mainnet (preview)</option>
    </select>
  );
}
