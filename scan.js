const fs = require("fs");
const path = require("path");
const { JsonRpcProvider, Contract, formatEther } = require("ethers");

// ponytail: BSC mainnet RPC. Swap/add backups if rate-limited.
const RPC_URL = process.env.RPC_URL || "https://bsc-dataseed.binance.org";
const WALLETS_DIR = path.join(__dirname, "wallets");
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const OUT_FILE = path.join(__dirname, "scan-results.json");
const OUT_DIR = path.join(__dirname, "scan-result");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// walk wallets/<workspace>/<address>.json, ignore dotfiles (e.g. .DS_Store)
function listWalletFiles() {
  const out = [];
  for (const ws of fs.readdirSync(WALLETS_DIR)) {
    if (ws.startsWith(".")) continue;
    const wsPath = path.join(WALLETS_DIR, ws);
    if (!fs.statSync(wsPath).isDirectory()) continue;
    for (const f of fs.readdirSync(wsPath)) {
      if (!f.endsWith(".json")) continue;
      out.push({ workspace: ws, file: path.join(wsPath, f) });
    }
  }
  return out;
}

async function scanWallet(provider, address, tokens) {
  // native BNB first
  const balances = [];
  try {
    const raw = await provider.getBalance(address);
    balances.push({ symbol: "BNB", balance: Number(formatEther(raw)) });
  } catch (err) {
    balances.push({ symbol: "BNB", balance: null, error: err.shortMessage || err.message });
  }

  for (const t of tokens) {
    const contract = new Contract(t.address, ERC20_ABI, provider);
    try {
      const [raw, decimals] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals(),
      ]);
      const scaled = Number(decimals ? raw / 10n ** BigInt(decimals) : raw);
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
  const walletFiles = listWalletFiles();

  // group workspaces: { workspace: [ { address, scannedAt, tokens } ] }
  const existing = fs.existsSync(OUT_FILE)
    ? new Map(JSON.parse(fs.readFileSync(OUT_FILE, "utf8")).map((e) => [e.workspace, e.wallets]))
    : new Map();

  let count = 0;
  let skipped = 0;
  for (const { workspace, file } of walletFiles) {
    // ponytail: address = filename, file has no address field.
    const address = path.basename(file, ".json");
    const scannedAt = new Date().toISOString();
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));

    try {
      const balances = await scanWallet(provider, address, tokens);
      const funded = balances.filter((b) => b.balance && b.balance > 0);
      if (!funded.length) {
        skipped++;
        console.log(`[${workspace}] ${address} empty, skip`);
        continue;
      }

      // ponytail: spread full wallet (privateKey/mnemonic/etc) + balances.
      const list = existing.get(workspace) || [];
      const idx = list.findIndex((e) => e.address === address);
      const entry = { ...raw, address, scannedAt, tokens: balances };
      if (idx >= 0) list[idx] = entry;
      else list.push(entry);
      existing.set(workspace, list);
      count++;

      // write scan-result/<workspace>/<address>.json
      const wsDir = path.join(OUT_DIR, workspace);
      fs.mkdirSync(wsDir, { recursive: true });
      fs.writeFileSync(path.join(wsDir, `${address}.json`), JSON.stringify(entry, null, 2));

      console.log(`[${workspace}] ${address} @ ${scannedAt}`);
      for (const b of balances) {
        console.log(`  ${b.symbol}: ${b.balance ?? "error"}`);
      }
    } catch (err) {
      console.error(`Failed ${workspace}/${address}: ${err.shortMessage || err.message}`);
    }
  }

  const out = [...existing.entries()].map(([workspace, wallets]) => ({ workspace, wallets }));
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWritten ${count} funded (${skipped} empty skipped) across ${out.length} workspace(s)`);
  console.log(`scan-results.json + scan-result/<workspace>/<address>.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
