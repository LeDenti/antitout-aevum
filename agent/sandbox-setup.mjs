// Owner-side setup of the sandbox (run locally, with the owner key of .keys/):
// asks the relayer for its agent address and ML-DSA-65 public key, deploys a dedicated sandbox vault
// (or reuses the one in web/sandbox.json), grants the agent a session with tiny caps, lists the two
// known payees, funds the vault and sends the agent some testnet gas. Writes web/sandbox.json.
//   node sandbox-setup.mjs --relayer https://<relayer>            first time: new vault
//   node sandbox-setup.mjs --relayer https://<other> --reuse      same vault, one more relayer agent
//   node sandbox-setup.mjs --refill 0.10                          move more tUSD8 into the vault
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseEther, keccak256 } from "viem";
import { publicClient, wallet, account, artifact, erc20Abi, TUSD8, U, fmt, explorerTx, ROOT } from "./common.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);
const FILE = join(ROOT, "web", "sandbox.json");
const C = U / 100n;
// tiny on purpose: the sandbox is public
const P = { perTx: 2n * C, daily: 10n * C, review: 1000n * C, strikes: 3, quarantine: 120n, validDays: 30n, fund: 25n * C, gas: "0.3" };
const { abi, bytecode } = artifact();
const A = Object.fromEntries(["owner", "guardian", "supplier", "freelancer", "attacker"].map((r) => [r, account(r).address]));
const cfg = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const tx = async (label, hash) => { const r = await publicClient.waitForTransactionReceipt({ hash }); console.log(`${label.padEnd(52)} ${explorerTx(hash)}`); return r; };
const own = (functionName, args, extra = {}) => wallet("owner").writeContract({ address: extra.address ?? cfg.vault, abi: extra.abi ?? abi, functionName, args });

if (has("--refill")) {
  const amount = BigInt(Math.round(Number(arg("--refill")) * 1e6));
  await tx(`refill the sandbox vault with ${fmt(amount)}`, await own("transfer", [cfg.vault, amount], { address: TUSD8, abi: erc20Abi }));
  process.exit(0);
}

const relayer = arg("--relayer");
if (!relayer) throw new Error("--relayer <url> is required");
const info = await (await fetch(`${relayer.replace(/\/$/, "")}/info`)).json();
console.log(`relayer agent ${info.agent}, ML-DSA-65 key hash ${info.pqKeyHash}`);
if (keccak256(info.pqPublicKey) !== info.pqKeyHash) throw new Error("relayer key hash mismatch");

if (!cfg.vault || !has("--reuse")) {
  const r = await tx("deploy the sandbox vault", await wallet("owner").deployContract({ abi, bytecode, args: [TUSD8, A.owner, A.guardian, P.strikes, P.quarantine, P.review] }));
  cfg.vault = r.contractAddress;
  cfg.fromBlock = Number(r.blockNumber);
  await tx("membrane: supplier is known", await own("setRecipient", [A.supplier, true]));
  await tx("membrane: freelancer is known", await own("setRecipient", [A.freelancer, true]));
  await tx(`fund the vault with ${fmt(P.fund)}`, await own("transfer", [cfg.vault, P.fund], { address: TUSD8, abi: erc20Abi }));
}
const validUntil = (await publicClient.getBlock()).timestamp + P.validDays * 86400n;
await tx("grant the relayer agent its session", await own("grantSession", [info.agent, P.perTx, P.daily, validUntil, info.pqKeyHash]));
if ((await publicClient.getBalance({ address: info.agent })) < parseEther("0.05"))
  await tx(`send ${P.gas} tQDAY of gas to the agent`, await wallet("owner").sendTransaction({ to: info.agent, value: parseEther(P.gas) }));

Object.assign(cfg, {
  chainId: 44005, relayer: relayer.replace(/\/$/, ""), agent: info.agent, pqPublicKey: info.pqPublicKey, tUSD8: TUSD8,
  addresses: { supplier: A.supplier, freelancer: A.freelancer, attacker: A.attacker, owner: A.owner, guardian: A.guardian },
  policy: { perTx: "0.02", daily: "0.10", strikes: P.strikes, quarantineSeconds: Number(P.quarantine), validUntil: Number(validUntil) },
});
writeFileSync(FILE, JSON.stringify(cfg, null, 2));
console.log(`sandbox vault ${cfg.vault} · written ${FILE}`);
