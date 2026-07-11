const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Contract } = require("ethers");
const { formatUnits } = require("ethers");

// ponytail: BSC mainnet RPC. Swap/add backups if rate-limited.
const RPC_URL = process.env.RPC_URL || "https://bsc-dataseed.binance.org";
const WALLETS_DIR = path.join(__dirname, "wallets");
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const OUT_FILE = path.join(__dirname, "scan-results.json");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

async function scanWallet(provider, address, tokens) {
  const balances = [];
  for (const t of tokens) {
    const contract = new Contract(t.address, ERC20_ABI, provider);
    try {
      const [raw, decimals] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals(),
      ]);
      const scaled = formatUnits(raw, decimals);
      balances.push({ symbol: t.symbol, address: t.address, balance: scaled });
    } catch (err) {
      balances.push({
        symbol: t.symbol,
        address: t.address,
        balance: null,
        error: err.shortMessage || err.message,
      });
    }
  }
  return balances;
}

async function loadTokens(provider) {
  // ponytail: prefer tokens.json; fall back to argv contract addresses,
  // auto-fetching symbol from each contract on-chain.
  if (fs.existsSync(TOKENS_FILE)) {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  }
  const args = process.argv.slice(2).filter((a) => a.startsWith("0x"));
  if (!args.length) {
    throw new Error("No tokens.json and no contract address arg. Usage: node scan.js 0xCONTRACT ...");
  }
  const out = [];
  for (const address of args) {
    const c = new Contract(address, ERC20_ABI, provider);
    let symbol;
    try {
      symbol = await c.symbol();
    } catch (err) {
      symbol = "UNKNOWN";
      console.error(`symbol() failed for ${address}: ${err.shortMessage || err.message}`);
    }
    out.push({ symbol, address });
    console.log(`Resolved ${address} -> ${symbol}`);
  }
  return out;
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const tokens = await loadTokens(provider);
  const files = fs.readdirSync(WALLETS_DIR).filter((f) => f.endsWith(".json"));

  const existing = fs.existsSync(OUT_FILE)
    ? JSON.parse(fs.readFileSync(OUT_FILE, "utf8"))
    : [];

  for (const file of files) {
    const wallet = JSON.parse(fs.readFileSync(path.join(WALLETS_DIR, file), "utf8"));
    const address = wallet.address;
    const scannedAt = new Date().toISOString();

    try {
      const balances = await scanWallet(provider, address, tokens);
      // ponytail: append new entry each run. Uniqueness by (address + scannedAt).
      // If you want only one record per wallet, replace existing address instead.
      const idx = existing.findIndex((e) => e.address === address);
      const entry = { address, scannedAt, tokens: balances };
      if (idx >= 0) existing[idx] = entry;
      else existing.push(entry);

      console.log(`${address} @ ${scannedAt}`);
      for (const b of balances) {
        console.log(`  ${b.symbol}: ${b.balance ?? "error"}`);
      }
    } catch (err) {
      console.error(`Failed ${address}: ${err.shortMessage || err.message}`);
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(existing, null, 2));
  console.log(`\nWritten ${existing.length} wallet(s) to ${OUT_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
