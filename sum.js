const fs = require("fs");
const path = require("path");

const SCAN_DIR = path.join(__dirname, "scan-result");
const OUT_FILE = path.join(__dirname, "scan-summary.json");

// aggregate token balances across a list of wallet entries
function sumTokens(wallets) {
  const totals = new Map(); // symbol -> { symbol, address?, total }
  for (const w of wallets) {
    for (const t of w.tokens || []) {
      if (t.balance == null) continue;
      const cur = totals.get(t.symbol) || { symbol: t.symbol, address: t.address || null, total: 0 };
      cur.total += t.balance;
      if (!cur.address && t.address) cur.address = t.address;
      totals.set(t.symbol, cur);
    }
  }
  return [...totals.values()];
}

function main() {
  if (!fs.existsSync(SCAN_DIR)) {
    console.error(`No ${SCAN_DIR}. Run scan.js first.`);
    process.exit(1);
  }

  const workspaces = [];
  const grandTotals = new Map();

  for (const ws of fs.readdirSync(SCAN_DIR).sort()) {
    if (ws.startsWith(".")) continue;
    const wsPath = path.join(SCAN_DIR, ws);
    if (!fs.statSync(wsPath).isDirectory()) continue;

    const wallets = [];
    for (const f of fs.readdirSync(wsPath)) {
      if (!f.endsWith(".json")) continue;
      try {
        wallets.push(JSON.parse(fs.readFileSync(path.join(wsPath, f), "utf8")));
      } catch (err) {
        console.error(`skip ${ws}/${f}: ${err.message}`);
      }
    }
    if (!wallets.length) continue;

    const totals = sumTokens(wallets);
    workspaces.push({ workspace: ws, walletCount: wallets.length, totals });

    // accumulate grand totals
    for (const t of totals) {
      const cur = grandTotals.get(t.symbol) || { symbol: t.symbol, address: t.address || null, total: 0, wallets: 0 };
      cur.total += t.total;
      cur.wallets += wallets.length;
      grandTotals.set(t.symbol, cur);
    }

    console.log(`\n[${ws}] ${wallets.length} wallet(s)`);
    for (const t of totals) console.log(`  ${t.symbol}: ${t.total}`);
  }

  const grand = [...grandTotals.values()];
  const out = {
    scannedAt: new Date().toISOString(),
    workspaceCount: workspaces.length,
    grandTotals: grand,
    workspaces,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`\n=== GRAND TOTAL (${workspaces.length} workspaces) ===`);
  for (const t of grand) console.log(`  ${t.symbol}: ${t.total}`);
  console.log(`\nWritten ${OUT_FILE}`);
}

main();
