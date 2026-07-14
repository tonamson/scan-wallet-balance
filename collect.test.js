const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { gasTopUp, removeWalletFile, walletIsEmpty } = require("./collect");

test("removes a completed wallet file", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "collect-")), "wallet.json");
  fs.writeFileSync(file, "{}");

  removeWalletFile(file);

  assert.equal(fs.existsSync(file), false);
});

test("keeps a wallet with remaining BNB", async () => {
  const wallet = { address: "0x0000000000000000000000000000000000000001" };

  assert.equal(await walletIsEmpty(wallet, { getBalance: async () => 0n }, []), true);
  assert.equal(await walletIsEmpty(wallet, { getBalance: async () => 1n }, []), false);
});

test("calculates only the missing BNB gas", () => {
  assert.equal(gasTopUp(0n, 10n), 10n);
  assert.equal(gasTopUp(7n, 10n), 3n);
  assert.equal(gasTopUp(10n, 10n), 0n);
});
