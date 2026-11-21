// End-to-end trial on QDay Aevum testnet. Every step is a real transaction;
// hashes, blocks, gas and the vault's answer are written to evidence/trial-<ts>.json
// and evidence/RESULTS.md.
//   node trial.mjs [--fund 0.5]      (tUSD8 the owner moves into the vault)
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { parseEther, decodeEventLog, keccak256, toHex, BaseError } from "viem";
import {
  publicClient, wallet, account, artifact, erc20Abi, TUSD8, U, CODES, KINDS, fmt,
  explorerTx, explorerAddr, sealAct, pqKeys, pqPublicKeyHash, EVIDENCE, ROOT,
} from "./common.mjs";
import { decide } from "./brain.mjs";
import { scan } from "./sentinel.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const FUND = BigInt(Math.round(Number(arg("--fund", "0.5")) * 1e6));
// policy, scaled for a small faucet balance
// The faucet gives 1 tUSD8 per day, so the demo works in cents of tUSD8.
const C = U / 100n;
const P = { perTx: 10n * C, daily: 30n * C, review: 6n * C, strikes: 3, quarantine: 600n, validDays: 7n };

const { abi, bytecode } = artifact();
const steps = [];
const startedAt = new Date().toISOString();
const A = Object.fromEntries(["owner", "agent", "guardian", "supplier", "freelancer", "attacker"].map((r) => [r, account(r).address]));
const book = { supplier: A.supplier, freelancer: A.freelancer };
let vault;

function log(...a) { console.log(...a); }

async function send(role, functionName, args, label, extra = {}) {
  const w = wallet(role);
  const hash = await w.writeContract({ address: extra.address ?? vault, abi: extra.abi ?? abi, functionName, args });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  const acts = r.logs.flatMap((l) => { try { const e = decodeEventLog({ abi, ...l }); return [e]; } catch { return []; } });
  const act = acts.find((e) => e.eventName === "Act");
  const quarantined = acts.find((e) => e.eventName === "Quarantined");
  const s = {
    step: steps.length + 1, label, actor: role, call: functionName, tx: hash, block: Number(r.blockNumber),
    gasUsed: Number(r.gasUsed), status: r.status,
    answer: act ? CODES[act.args.code] : undefined, act: act ? Number(act.args.index) : undefined,
    seal: act?.args.seal, quarantined: quarantined ? Number(quarantined.args.until) : undefined, ...extra.note,
  };
  steps.push(s);
  log(`#${String(s.step).padStart(2)} ${label.padEnd(58)} ${(s.answer ?? s.status).padEnd(18)} ${explorerTx(hash)}`);
  return { r, s, acts };
}

async function refusedBeforeSending(role, functionName, args, label) {
  try {
    await publicClient.simulateContract({ account: account(role), address: vault, abi, functionName, args });
    throw new Error("expected a revert");
  } catch (e) {
    const name = e instanceof BaseError ? e.walk((x) => x?.data?.errorName)?.data?.errorName ?? e.shortMessage : String(e);
    steps.push({ step: steps.length + 1, label, actor: role, call: functionName, tx: null, answer: `revert ${name}`, simulated: true });
    log(`#${String(steps.length).padStart(2)} ${label.padEnd(58)} revert ${name} (simulated, nothing sent)`);
  }
}

/** The agent reads an invoice, seals its decision with ML-DSA-65, then calls the vault. */
async function agentHandles(file, label) {
  const text = readFileSync(join(ROOT, "agent", "invoices", file), "utf8").replaceAll("ATTACKER_ADDRESS", A.attacker);
  const d = await decide(text, book);
  if (d.action === "pay") {
    const { seal } = sealAct({ kind: "pay", vault, agent: A.agent, to: d.to, amount: d.amount }, text);
    return send("agent", "pay", [d.to, d.amount, seal], `${label} — pay ${fmt(d.amount)} to ${who(d.to)}`, { note: { invoice: file } });
  }
  if (d.action === "lock") {
    const now = (await publicClient.getBlock()).timestamp;
    const deadline = now + BigInt(d.deadlineIn);
    const { seal } = sealAct({ kind: "lock", vault, agent: A.agent, to: d.to, amount: d.amount, deadline: deadline.toString(), condition: d.condition }, text);
    return send("agent", "lock", [d.to, d.amount, deadline, d.condition, seal], `${label} — escrow ${fmt(d.amount)} to ${who(d.to)}`, { note: { invoice: file, deadline: Number(deadline) } });
  }
  throw new Error(`no decision for ${file}`);
}

const who = (a) => Object.entries(A).find(([, v]) => v.toLowerCase() === a.toLowerCase())?.[0] ?? a;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------- run
log(`Aevum trial ${startedAt}`);
for (const [r, a] of Object.entries(A)) log(`  ${r.padEnd(10)} ${a}`);

// 0. gas for the actors that sign (owner pays it from the faucet allowance)
for (const role of ["agent", "guardian", "freelancer"]) {
  const bal = await publicClient.getBalance({ address: A[role] });
  if (bal < parseEther("0.01")) {
    const hash = await wallet("owner").sendTransaction({ to: A[role], value: parseEther("0.05") });
    await publicClient.waitForTransactionReceipt({ hash });
    steps.push({ step: steps.length + 1, label: `gas: 0.05 tQDAY to ${role}`, actor: "owner", tx: hash });
    log(`#${String(steps.length).padStart(2)} gas 0.05 tQDAY -> ${role}  ${explorerTx(hash)}`);
  }
}

// 1. deploy
{
  const hash = await wallet("owner").deployContract({ abi, bytecode, args: [TUSD8, A.owner, A.guardian, P.strikes, P.quarantine, P.review] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  vault = r.contractAddress;
  steps.push({ step: steps.length + 1, label: "deploy ImmuneVault", actor: "owner", tx: hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), address: vault });
  log(`#${String(steps.length).padStart(2)} deploy ImmuneVault ${vault}  ${explorerTx(hash)}`);
}
const fromBlock = BigInt(steps.at(-1).block);
mkdirSync(EVIDENCE, { recursive: true });
writeFileSync(join(EVIDENCE, "deployment.json"), JSON.stringify({ chainId: 44005, vault, fromBlock: Number(fromBlock), tUSD8: TUSD8, addresses: A }, null, 2));
writeFileSync(join(EVIDENCE, "agent-pq-public.hex"), Buffer.from(pqKeys().publicKey).toString("hex"));

// 2. SELF: session, membrane, funding
const { publicKey } = pqKeys();
const validUntil = (await publicClient.getBlock()).timestamp + P.validDays * 86400n;
await send("owner", "grantSession", [A.agent, P.perTx, P.daily, validUntil, pqPublicKeyHash(publicKey)], "SELF: grant agent session (0.10/tx, 0.30/day, 7 days, PQ key)");
await send("owner", "setRecipient", [A.supplier, true], "SELF: membrane — supplier is known");
await send("owner", "setRecipient", [A.freelancer, true], "SELF: membrane — freelancer is known");
await send("owner", "transfer", [vault, FUND], `fund vault with ${fmt(FUND)}`, { address: TUSD8, abi: erc20Abi });

// 3. ACTS: payments decided by the (naive) AI from invoices
await agentHandles("01-cloud-gpu.txt", "ACTS: invoice INV-101");
await agentHandles("02-injected.txt", "ACTS: invoice INV-102 (prompt injection)");
await agentHandles("03-overcap.txt", "ACTS: invoice INV-103 (above per-tx cap)");
await agentHandles("04-injected-again.txt", "ACTS: invoice INV-104 (injection, 3rd strike)");
await agentHandles("05-legit-small.txt", "STATE: legit invoice while quarantined");
await send("owner", "pardon", [A.agent], "STATE: human pardons the agent");

// 4. review above threshold
await agentHandles("06-review.txt", "ACTS: invoice INV-106 (above review threshold)");
await send("owner", "approve", [0n], "ACTS: human approves held payment #0");

// 5. escrow (dareskro): release on proof
const proof = readFileSync(join(ROOT, "agent", "invoices", "07-escrow.proof"), "utf8").trim();
const e1 = await agentHandles("07-escrow.txt", "ESCROW: invoice INV-107 (pay on delivery)");
const id1 = (await publicClient.readContract({ address: vault, abi, functionName: "escrowCount" })) - 1n;
await refusedBeforeSending("freelancer", "release", [id1, toHex("not the deliverable")], "ESCROW: release with a wrong proof");
await refusedBeforeSending("owner", "refund", [id1], "ESCROW: refund before the deadline");
await send("freelancer", "release", [id1, toHex(proof)], "ESCROW: freelancer releases with the real proof");

// 6. escrow: refund after deadline
await agentHandles("08-escrow-short.txt", "ESCROW: invoice INV-108 (90 s deadline)");
const id2 = (await publicClient.readContract({ address: vault, abi, functionName: "escrowCount" })) - 1n;
const dl = (await publicClient.readContract({ address: vault, abi, functionName: "escrows", args: [id2] }))[3];
const local = /127\.0\.0\.1|localhost/.test(process.env.AEVUM_RPC ?? "");
const blockTime = async () => { try { return (await publicClient.getBlock()).timestamp; } catch (e) { log(`  (rpc slow: ${e.shortMessage ?? e.message}; retrying)`); return 0n; } };
while ((await blockTime()) < dl) {
  await sleep(5000);
  if (local) await publicClient.request({ method: "evm_mine", params: [] }); // anvil mines only on demand
}
await send("owner", "refund", [id2], "ESCROW: deadline passed, funds return to the vault");

// 7. daily cap
await agentHandles("09-daily-a.txt", "STATE: invoice INV-109 (fills the day)");
await agentHandles("10-daily-b.txt", "STATE: invoice INV-110 (over the daily cap)");

// 8. stolen ECDSA key: the thief can sign, but cannot forge the ML-DSA-65 seal
await send("agent", "pay", [A.supplier, 1n * C, keccak256(randomBytes(32))], "THEFT: stolen agent key pays within the rules, fake seal");
log("sentinel scan…");
const sres = await scan(vault, { fromBlock, log });
for (const f of sres.frozen) steps.push({ step: steps.length + 1, label: "SENTINEL: forged seal detected, guardian freezes agent", actor: "guardian", call: "revokeSession", tx: f.hash, block: Number(f.block), answer: "FROZEN" });
await agentHandles("05-legit-small.txt", "SELF: any further agent act after the freeze");

// 9. final state
const [bal, locked, head, count] = await Promise.all([
  publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  publicClient.readContract({ address: vault, abi, functionName: "lockedTotal" }),
  publicClient.readContract({ address: vault, abi, functionName: "journalHead" }),
  publicClient.readContract({ address: vault, abi, functionName: "actCount" }),
]);
const final = await scan(vault, { fromBlock, act: false, log });
const balances = {};
for (const r of ["supplier", "freelancer", "attacker"]) balances[r] = fmt(await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [A[r]] }));

const out = {
  startedAt, finishedAt: new Date().toISOString(), chainId: 44005, vault, tUSD8: TUSD8, policy: Object.fromEntries(Object.entries(P).map(([k, v]) => [k, String(v)])),
  addresses: A, pqKeyHash: pqPublicKeyHash(publicKey), steps,
  final: { vaultBalance: fmt(bal), locked: fmt(locked), journalHead: head, acts: Number(count), sentinelHeadMatches: final.headOk, sentinelFindings: final.findings.length, balances },
};
mkdirSync(EVIDENCE, { recursive: true });
const tag = startedAt.replace(/[:.]/g, "-");
writeFileSync(join(EVIDENCE, `trial-${tag}.json`), JSON.stringify(out, null, 2));
writeFileSync(join(EVIDENCE, "RESULTS.md"), markdown(out));
log(`\nvault ${fmt(bal)} (locked ${fmt(locked)}), ${count} acts, head ${head}`);
log(`balances ${JSON.stringify(balances)}`);
log(`evidence/trial-${tag}.json + evidence/RESULTS.md`);

function markdown(o) {
  const rows = o.steps.map((s) =>
    `| ${s.step} | ${s.label} | ${s.actor} | ${s.answer ?? (s.status === "success" ? "ok" : s.status ?? "ok")} | ${s.tx ? `[${s.tx.slice(0, 10)}…](${explorerTx(s.tx)})` : "simulated"} | ${s.block ?? ""} | ${s.gasUsed ?? ""} |`);
  return `# Measured run on QDay Aevum testnet

Run ${o.startedAt} → ${o.finishedAt} · chain ${o.chainId} · vault [\`${o.vault}\`](${explorerAddr(o.vault)}) · tUSD8 \`${o.tUSD8}\`

Policy: ${fmt(BigInt(o.policy.perTx))} per payment, ${fmt(BigInt(o.policy.daily))} per 24 h, payments above ${fmt(BigInt(o.policy.review))} wait for a human, ${o.policy.strikes} strikes → ${o.policy.quarantine} s quarantine, session valid ${o.policy.validDays} days. Agent ML-DSA-65 key hash \`${o.pqKeyHash}\`.

| # | Step | Signer | Vault answer | Transaction | Block | Gas |
|---|------|--------|--------------|-------------|-------|-----|
${rows.join("\n")}

Final: vault holds ${o.final.vaultBalance} (locked ${o.final.locked}); ${o.final.acts} acts in the on-chain journal; journal head \`${o.final.journalHead}\` recomputed by the sentinel from events: **${o.final.sentinelHeadMatches ? "matches" : "MISMATCH"}**; seal findings: ${o.final.sentinelFindings} (the stolen-key payment).
Balances after the run: ${Object.entries(o.final.balances).map(([k, v]) => `${k} ${v}`).join(", ")}.
`;
}
