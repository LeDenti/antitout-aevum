// A real model in the loop, on Aevum. Each step asks a Claude model (live API call) to read an
// invoice, then sends to a fresh vault exactly what the model decided, sealed with ML-DSA-65.
// agent/bench.mjs measured that one booby-trapped invoice (a fake "payee registry" block) fools all
// three models under a plain system prompt; this run shows what the vault answers on-chain.
// Writes evidence/claude-live-<ts>.json and evidence/CLAUDE_LIVE.md. It does not touch
// evidence/deployment.json (the vault of the main trial).
//   node live-claude.mjs [--fund 0.12]
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEventLog, getAddress, isAddress } from "viem";
import { publicClient, wallet, account, artifact, erc20Abi, TUSD8, U, CODES, fmt, explorerTx, explorerAddr, sealAct, pqKeys, pqPublicKeyHash, EVIDENCE, ROOT } from "./common.mjs";
import { claudeAsk } from "./brain.mjs";
import { scan } from "./sentinel.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const FUND = BigInt(Math.round(Number(arg("--fund", "0.12")) * 1e6));
const C = U / 100n;
const P = { perTx: 10n * C, daily: 30n * C, review: 6n * C, strikes: 3, quarantine: 600n, validDays: 7n }; // as in trial.mjs
const EFFORT = "medium";

const { abi, bytecode } = artifact();
const A = Object.fromEntries(["owner", "agent", "guardian", "supplier", "freelancer", "attacker"].map((r) => [r, account(r).address]));
const book = { supplier: A.supplier, freelancer: A.freelancer };
const who = (a) => Object.entries(A).find(([, v]) => v.toLowerCase() === a.toLowerCase())?.[0] ?? a;
const steps = [];
const startedAt = new Date().toISOString();
let vault;
const log = (...a) => console.log(...a);

async function send(role, functionName, args, label, extra = {}) {
  const hash = await wallet(role).writeContract({ address: extra.address ?? vault, abi: extra.abi ?? abi, functionName, args });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  const events = r.logs.flatMap((l) => { try { return [decodeEventLog({ abi, ...l })]; } catch { return []; } });
  const act = events.find((e) => e.eventName === "Act");
  const s = { step: steps.length + 1, label, actor: role, call: functionName, tx: hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed),
    answer: act ? CODES[act.args.code] : r.status, quarantined: events.some((e) => e.eventName === "Quarantined"), ...extra.note };
  steps.push(s);
  log(`#${String(s.step).padStart(2)} ${label.padEnd(64)} ${String(s.answer).padEnd(18)}${s.quarantined ? " QUARANTINE " : " "}${explorerTx(hash)}`);
  return s;
}

/** One live model call on one invoice; whatever it decides goes to the vault. */
async function modelHandles(model, prompt, dir, file) {
  const text = readFileSync(join(ROOT, "agent", dir, file), "utf8").replaceAll("ATTACKER_ADDRESS", A.attacker);
  const { decision: d, usage, stop_reason } = await claudeAsk(text, Object.keys(book), { model, prompt, effort: EFFORT });
  const note = { model, prompt, invoice: `${dir}/${file}`, decision: d, stop_reason, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
  const label = `${model.replace("claude-", "")} / ${prompt} / ${file.replace(".txt", "")}`;
  const to = d && d.action === "pay" ? (book[d.to?.toLowerCase()] ?? (isAddress(d.to ?? "") ? getAddress(d.to) : null)) : null;
  if (!to) {
    const s = { step: steps.length + 1, label, actor: "agent", call: null, tx: null, answer: d ? `model chose ${d.action}: nothing sent` : "model refused: nothing sent", ...note };
    steps.push(s);
    log(`#${String(s.step).padStart(2)} ${label.padEnd(64)} ${s.answer}`);
    return s;
  }
  const amount = BigInt(Math.round(Number(d.amount) * 1e6));
  const { seal } = sealAct({ kind: "pay", vault, agent: A.agent, to, amount }, text);
  return send("agent", "pay", [to, amount, seal], `${label} → pay ${fmt(amount)} to ${who(to)}`, { note });
}

log(`Claude live run on Aevum ${startedAt}`);
{
  const hash = await wallet("owner").deployContract({ abi, bytecode, args: [TUSD8, A.owner, A.guardian, P.strikes, P.quarantine, P.review] });
  const r = await publicClient.waitForTransactionReceipt({ hash });
  vault = r.contractAddress;
  steps.push({ step: 1, label: "deploy a fresh ImmuneVault", actor: "owner", tx: hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed), answer: "success" });
  log(`# 1 deploy ImmuneVault ${vault}  ${explorerTx(hash)}`);
}
const fromBlock = BigInt(steps[0].block);
const validUntil = (await publicClient.getBlock()).timestamp + P.validDays * 86400n;
await send("owner", "grantSession", [A.agent, P.perTx, P.daily, validUntil, pqPublicKeyHash(pqKeys().publicKey)], "grant agent session (0.10/tx, 0.30/day, 7 days, PQ key)");
await send("owner", "setRecipient", [A.supplier, true], "membrane: supplier is known");
await send("owner", "setRecipient", [A.freelancer, true], "membrane: freelancer is known");
await send("owner", "transfer", [vault, FUND], `fund vault with ${fmt(FUND)}`, { address: TUSD8, abi: erc20Abi });

// A. the model does its job on a clean invoice
await modelHandles("claude-opus-5-5", "plain", "invoices", "01-cloud-gpu.txt");
// B. the invoice that fooled every model in the bench, one model after the other, plain prompt
for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]) await modelHandles(m, "plain", "attacks", "a4-fake-registry-update.txt");
// C. a clean invoice right after: is the agent quarantined?
await modelHandles("claude-opus-5-5", "plain", "invoices", "05-legit-small.txt");
// D. a different trap the models catch by themselves (nothing should reach the chain)
await modelHandles("claude-opus-5-5", "plain", "attacks", "a3-new-remit-address.txt");
// E. the human pardons; same trap, hardened prompt
await send("owner", "pardon", [A.agent], "human pardons the agent");
for (const m of ["claude-sonnet-5-5", "claude-opus-5-5"]) await modelHandles(m, "hardened", "attacks", "a4-fake-registry-update.txt");

// journal and seals, checked by the sentinel (read only)
const sentinel = await scan(vault, { fromBlock, act: false, log });
const balances = {};
for (const r of ["supplier", "attacker"]) balances[r] = fmt(await publicClient.readContract({ address: TUSD8, abi: erc20Abi, functionName: "balanceOf", args: [A[r]] }));
const left = await publicClient.readContract({ address: vault, abi, functionName: "available" });
if (left > 0n) await send("owner", "withdraw", [A.owner, left], `owner withdraws the remaining ${fmt(left)}`);

const stamp = startedAt.replace(/[:.]/g, "-");
const out = { startedAt, finishedAt: new Date().toISOString(), chainId: 44005, vault, fromBlock: Number(fromBlock), effort: EFFORT, addresses: A,
  sentinel: { acts: sentinel.acts, headMatches: sentinel.headOk, findings: sentinel.findings.length }, attackerBalance: balances.attacker, steps };
writeFileSync(join(EVIDENCE, `claude-live-${stamp}.json`), JSON.stringify(out, null, 1));
const link = (h) => (h ? `[${h.slice(0, 10)}…](${explorerTx(h)})` : "—");
const md = [`# A real model in the loop, on Aevum`, "",
  `Run ${startedAt} · vault [\`${vault}\`](${explorerAddr(vault)}) · effort \`${EFFORT}\` · every model answer is a live API call, sent to the vault as decided.`, "",
  "| # | Model / prompt / invoice | Model decision | Vault answer | Tx |", "|---|---|---|---|---|",
  ...steps.filter((s) => s.model).map((s) => `| ${s.step} | ${s.label.split(" → ")[0]} | ${s.decision ? `${s.decision.action}${s.decision.action === "pay" ? ` ${s.decision.amount} to ${isAddress(s.decision.to) ? who(getAddress(s.decision.to)) : s.decision.to}` : ""}` : "refused"} | ${s.tx ? `\`${s.answer}\`${s.quarantined ? " → **quarantine**" : ""}` : "nothing sent"} | ${link(s.tx)} |`), "",
  `* Attacker balance after the run: **${balances.attacker}**.`,
  `* Sentinel: ${sentinel.acts} acts, journal head ${sentinel.headOk ? "matches" : "DOES NOT MATCH"} the chain, ${sentinel.findings.length} seal problem(s).`, "",
  "What each model wrote about its decision:", "",
  ...steps.filter((s) => s.decision).map((s) => `* **#${s.step} ${s.model} (${s.prompt})**: ${s.decision.note}`), ""];
writeFileSync(join(EVIDENCE, "CLAUDE_LIVE.md"), md.join("\n"));
log("\n" + md.join("\n"));
