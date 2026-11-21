// Shared helpers: chain, keys, contract artifact, ML-DSA-65 seals.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, defineChain, keccak256, concat, toHex, toBytes, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const KEYS = join(ROOT, ".keys");
export const EVIDENCE = join(ROOT, "evidence");
export const SEALS = join(EVIDENCE, "seals");

export const aevum = defineChain({
  id: 44005,
  name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [process.env.AEVUM_RPC || "https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
});

export const TUSD8 = getAddress("0x456569838f1d43009A91ebA4263147Afd7233483");
export const U = 1_000_000n; // tUSD8 has 6 decimals
export const explorerTx = (h) => `${aevum.blockExplorers.default.url}/tx/${h}`;
export const explorerAddr = (a) => `${aevum.blockExplorers.default.url}/address/${a}`;

export const publicClient = createPublicClient({ chain: aevum, transport: http(undefined, { timeout: 30_000, retryCount: 8, retryDelay: 1500 }) });

// ---------------------------------------------------------------- keys (never printed)
export const ROLES = ["owner", "agent", "guardian", "supplier", "freelancer", "attacker"];

export function loadKey(role) {
  const p = join(KEYS, `${role}.json`);
  if (!existsSync(p)) throw new Error(`missing key ${role}: run "node keys.mjs init"`);
  return JSON.parse(readFileSync(p, "utf8"));
}

export function account(role) {
  return privateKeyToAccount(loadKey(role).privateKey);
}

export function wallet(role) {
  return createWalletClient({ account: account(role), chain: aevum, transport: http(undefined, { timeout: 30_000, retryCount: 8, retryDelay: 1500 }) });
}

export function saveSecret(name, obj) {
  mkdirSync(KEYS, { recursive: true, mode: 0o700 });
  const p = join(KEYS, name);
  writeFileSync(p, JSON.stringify(obj, null, 2), { mode: 0o600 });
  chmodSync(p, 0o600);
}

// ---------------------------------------------------------------- ML-DSA-65 key of the agent
export function pqKeys() {
  const k = loadKey("agent-pq");
  const seed = Uint8Array.from(Buffer.from(k.seed, "hex"));
  return ml_dsa65.keygen(seed); // deterministic from the 32-byte seed
}

export function pqPublicKeyHash(publicKey) {
  return keccak256(publicKey);
}

// ---------------------------------------------------------------- seals
const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));

/** Seal an act before it is sent: ML-DSA-65 over a canonical record. */
export function sealAct(fields, intentText) {
  const { secretKey, publicKey } = pqKeys();
  const record = canon({
    v: 1,
    chainId: aevum.id,
    issuedAt: new Date().toISOString(),
    intentSha3: bytesToHex(sha3_256(new TextEncoder().encode(intentText ?? ""))),
    ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  });
  const recordBytes = new TextEncoder().encode(record);
  const signature = ml_dsa65.sign(recordBytes, secretKey);
  const seal = keccak256(concat([recordBytes, signature]));
  mkdirSync(SEALS, { recursive: true });
  writeFileSync(
    join(SEALS, `${seal}.json`),
    JSON.stringify({ seal, record, signature: Buffer.from(signature).toString("base64"), pqKeyHash: pqPublicKeyHash(publicKey) }, null, 2),
  );
  return { seal, record, signature };
}

/** Check a seal found on-chain against the stored record and the agent's PQ key. */
export function verifySeal(seal, publicKey, expect) {
  const p = join(SEALS, `${seal}.json`);
  if (!existsSync(p)) return { ok: false, why: "no sealed record for this act" };
  const s = JSON.parse(readFileSync(p, "utf8"));
  const recordBytes = new TextEncoder().encode(s.record);
  const sig = Uint8Array.from(Buffer.from(s.signature, "base64"));
  if (keccak256(concat([recordBytes, sig])) !== seal) return { ok: false, why: "seal does not match record+signature" };
  if (!ml_dsa65.verify(sig, recordBytes, publicKey)) return { ok: false, why: "ML-DSA-65 signature invalid" };
  const r = JSON.parse(s.record);
  for (const [k, v] of Object.entries(expect)) {
    if (String(r[k]).toLowerCase() !== String(v).toLowerCase()) return { ok: false, why: `record.${k}=${r[k]} but chain says ${v}` };
  }
  return { ok: true, record: r };
}

// ---------------------------------------------------------------- contract artifact
export function artifact(name = "ImmuneVault") {
  const a = JSON.parse(readFileSync(join(ROOT, "out", `${name}.sol`, `${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

export const CODES = [
  "OK", "REVOKED", "EXPIRED", "QUARANTINED", "OVER_TX_CAP", "OVER_DAILY_CAP",
  "UNKNOWN_RECIPIENT", "INSUFFICIENT_FUNDS", "HELD_FOR_REVIEW", "MISSING_SEAL", "BAD_ESCROW_TERMS",
];
export const KINDS = { 1: "pay", 2: "lock", 3: "release", 4: "refund", 5: "approve", 6: "reject" };

export const fmt = (v) => `${(Number(v) / 1e6).toFixed(2)} tUSD8`.replace(/^0\.(\d\d) /, "0.$1 ");
export { toHex, toBytes, keccak256 };
