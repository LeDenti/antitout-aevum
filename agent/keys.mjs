// Create the testnet keys locally. Private keys stay in ../.keys (0600, gitignored)
// and are never printed: only addresses and the PQ public-key hash are shown.
//   node keys.mjs init      create missing keys
//   node keys.mjs show      addresses + balances
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatEther } from "viem";
import { KEYS, ROLES, saveSecret, loadKey, pqKeys, pqPublicKeyHash, publicClient, TUSD8, erc20Abi, fmt } from "./common.mjs";

const cmd = process.argv[2] || "show";

if (cmd === "init") {
  for (const role of ROLES) {
    if (existsSync(join(KEYS, `${role}.json`))) continue;
    const privateKey = generatePrivateKey();
    saveSecret(`${role}.json`, { role, address: privateKeyToAccount(privateKey).address, privateKey });
  }
  if (!existsSync(join(KEYS, "agent-pq.json"))) {
    saveSecret("agent-pq.json", { scheme: "ML-DSA-65 (FIPS 204)", seed: randomBytes(32).toString("hex") });
  }
}

for (const role of ROLES) {
  const { address } = loadKey(role);
  let line = `${role.padEnd(10)} ${address}`;
  if (cmd === "show") {
    const [gas, usd] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    ]);
    line += `  ${Number(formatEther(gas)).toFixed(4)} tQDAY  ${fmt(usd)}`;
  }
  console.log(line);
}
const { publicKey } = pqKeys();
console.log(`agent PQ   ML-DSA-65 public key ${publicKey.length} bytes, keccak256 ${pqPublicKeyHash(publicKey)}`);
