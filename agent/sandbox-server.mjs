// Sandbox relayer: lets a visitor hand their own invoice to a throwaway agent on Aevum, without a wallet.
//
// The relayer holds the keys of ONE sandbox agent (ECDSA session key + ML-DSA-65 key), both derived
// from the SANDBOX_SEED environment variable, never written to disk or to the repository. That agent
// has a session with tiny caps in a dedicated sandbox vault (see sandbox-setup.mjs). The relayer cannot
// move funds by itself: it can only do what the vault lets this agent do. If the seed leaks, the thief
// gets the same tiny caps and the same membrane of known payees; the owner revokes the session.
//
//   SANDBOX_SEED=<long random string> node sandbox-server.mjs
//   GET  /info            agent address, ML-DSA-65 public key, vault, available brains
//   POST /handle          { invoice, brain }  ->  the agent's decision, its seal, the vault's answer, the tx
//   GET  /seal/0x…        the sealed record of an act sent by this relayer (to verify in the browser)
//
// Optional: ANTHROPIC_API_KEY enables the two "claude" brains (Claude Haiku 5.5, plain or hardened prompt).
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { createWalletClient, http, keccak256, concat, toBytes, toHex, parseAbi, decodeEventLog, getAddress, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { aevum, publicClient, CODES, explorerTx } from "./common.mjs";
import { naiveDecide, claudeAsk } from "./brain.mjs";

const SEED = process.env.SANDBOX_SEED;
if (!SEED || SEED.length < 32) {
  console.error("SANDBOX_SEED is missing or shorter than 32 characters.");
  process.exit(1);
}
const PORT = Number(process.env.PORT || 8790);
const ORIGINS = (process.env.ALLOW_ORIGIN || "https://ledenti.github.io,http://localhost:5191").split(",");
const CLAUDE_MODEL = "claude-haiku-5-5"; // the cheapest current model: this endpoint is public
const CLAUDE_DAILY_MAX = Number(process.env.CLAUDE_DAILY_MAX || 300);
const MIN_INTERVAL_MS = 6_000; // one act at a time on-chain, a few seconds apart
const PER_IP_PER_HOUR = 20;
const MAX_INVOICE = 2_000;

// ---------------------------------------------------------------- the sandbox agent (derived, never stored)
const derive = (label) => keccak256(toBytes(`immunevault-sandbox/${label}/${SEED}`));
const agent = privateKeyToAccount(derive("ecdsa"));
const pq = ml_dsa65.keygen(toBytes(derive("ml-dsa-65")));
const wallet = createWalletClient({ account: agent, chain: aevum, transport: http(undefined, { timeout: 30_000, retryCount: 4, retryDelay: 1500 }) });

// vault and demo addresses: published in web/sandbox.json by sandbox-setup.mjs (SANDBOX_VAULT overrides)
function config() {
  const f = new URL("../web/sandbox.json", import.meta.url);
  const c = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  return { vault: process.env.SANDBOX_VAULT || c.vault || null, addresses: c.addresses || {} };
}

const abi = parseAbi([
  "function pay(address to, uint128 amount, bytes32 seal) returns (uint8)",
  "event Act(uint256 indexed index, uint8 indexed kind, address indexed agent, address to, uint256 amount, uint8 code, bytes32 seal, uint256 ref, bytes32 head)",
  "event Quarantined(address indexed agent, uint64 until, uint32 strikes)",
]);

// ---------------------------------------------------------------- seals
const seals = new Map(); // seal -> record + signature, kept in memory (lost on restart; the hash stays on-chain)
const canon = (o) => JSON.stringify(Object.keys(o).sort().reduce((a, k) => ((a[k] = o[k]), a), {}));
function sealAct(fields, intentText) {
  const record = canon({ v: 1, chainId: aevum.id, issuedAt: new Date().toISOString(), intentSha3: bytesToHex(sha3_256(new TextEncoder().encode(intentText))), ...fields });
  const recordBytes = new TextEncoder().encode(record);
  const signature = ml_dsa65.sign(recordBytes, pq.secretKey);
  const seal = keccak256(concat([recordBytes, signature]));
  seals.set(seal, { seal, record, signature: Buffer.from(signature).toString("base64"), pqKeyHash: keccak256(pq.publicKey) });
  if (seals.size > 500) seals.delete(seals.keys().next().value);
  return seal;
}

// ---------------------------------------------------------------- limits
const hits = new Map(); // ip -> timestamps
let lastAct = 0;
let claudeDay = "", claudeCalls = 0;
let queue = Promise.resolve();
function allow(ip) {
  const now = Date.now();
  const h = (hits.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (h.length >= PER_IP_PER_HOUR) return false;
  h.push(now);
  hits.set(ip, h);
  return true;
}

// ---------------------------------------------------------------- one invoice
const BRAINS = () => ["naive", ...(process.env.ANTHROPIC_API_KEY ? ["claude-plain", "claude-hardened"] : [])];

async function decide(text, brain, book) {
  if (brain === "naive") {
    const d = naiveDecide(text, book);
    if (d.action === "pay") return { action: "pay", to: getAddress(d.to.toLowerCase()), amount: d.amount, note: "naive parser: obeys the last “Pay:” line it finds, comments included" };
    return { action: "none", note: d.action === "lock" ? "the sandbox handles direct payments only (escrow is shown in the main run)" : "no “Pay: <amount> tUSD8 to <payee>” line found" };
  }
  const day = new Date().toISOString().slice(0, 10);
  if (day !== claudeDay) (claudeDay = day), (claudeCalls = 0);
  if (++claudeCalls > CLAUDE_DAILY_MAX) throw Object.assign(new Error("The model budget of the sandbox is used up for today. The naive brain still works."), { status: 429 });
  const { decision: d } = await claudeAsk(text, Object.keys(book), { model: CLAUDE_MODEL, prompt: brain === "claude-hardened" ? "hardened" : "plain", effort: "low" });
  if (!d) return { action: "none", note: "the model refused to answer" };
  if (d.action !== "pay") return { action: "none", note: d.action === "lock" ? `the model chose escrow; the sandbox handles direct payments only. ${d.note}` : d.note };
  const to = book[d.to?.toLowerCase()] ?? (isAddress(d.to ?? "", { strict: false }) ? getAddress(d.to.toLowerCase()) : null);
  const amount = BigInt(Math.round(Number(d.amount) * 1e6));
  if (!to || !(amount > 0n)) return { action: "none", note: `the model named a payee or an amount the sandbox cannot read (“${d.to}”, “${d.amount}”). ${d.note}` };
  return { action: "pay", to, amount, note: d.note };
}

async function handle(invoice, brain) {
  const { vault, addresses } = config();
  if (!vault) throw Object.assign(new Error("The sandbox vault is not set up yet."), { status: 503 });
  const book = { supplier: addresses.supplier, freelancer: addresses.freelancer };
  const text = invoice.replaceAll("ATTACKER_ADDRESS", addresses.attacker ?? "");
  let d;
  try {
    d = await decide(text, brain, book);
  } catch (e) {
    if (e.status) throw e;
    // the naive parser throws on a payee name it does not know
    return { brain, decision: { action: "none", note: String(e.message) }, sent: false };
  }
  const who = (a) => Object.entries(addresses).find(([, v]) => v.toLowerCase() === a.toLowerCase())?.[0] ?? null;
  if (d.action !== "pay") return { brain, decision: d, sent: false };
  if (d.amount >= 2n ** 128n) return { brain, decision: { action: "none", note: "amount too large to send" }, sent: false };
  const wait = lastAct + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const seal = sealAct({ kind: "pay", vault, agent: agent.address, to: d.to, amount: d.amount.toString() }, text);
  const hash = await wallet.writeContract({ address: vault, abi, functionName: "pay", args: [d.to, d.amount, seal] });
  lastAct = Date.now();
  const r = await publicClient.waitForTransactionReceipt({ hash });
  const events = r.logs.flatMap((l) => { try { return [decodeEventLog({ abi, ...l })]; } catch { return []; } });
  const act = events.find((e) => e.eventName === "Act");
  return {
    brain, sent: true,
    decision: { action: "pay", to: d.to, toName: who(d.to), amount: (Number(d.amount) / 1e6).toFixed(2), note: d.note },
    seal, tx: hash, explorer: explorerTx(hash), block: Number(r.blockNumber),
    answer: act ? CODES[act.args.code] : r.status, act: act ? Number(act.args.index) : null,
    quarantined: events.some((e) => e.eventName === "Quarantined"),
  };
}

// ---------------------------------------------------------------- http
function send(res, status, body, origin) {
  const h = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin && ORIGINS.includes(origin)) Object.assign(h, { "access-control-allow-origin": origin, vary: "origin", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" });
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") return send(res, 204, {}, origin);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/info")) {
      const { vault } = config();
      return send(res, 200, { name: "ImmuneVault sandbox relayer", chainId: aevum.id, agent: agent.address, pqPublicKey: toHex(pq.publicKey), pqKeyHash: keccak256(pq.publicKey), vault, brains: BRAINS(), claudeModel: CLAUDE_MODEL, maxInvoice: MAX_INVOICE }, origin);
    }
    if (req.method === "GET" && url.pathname.startsWith("/seal/")) {
      const s = seals.get(url.pathname.slice(6).toLowerCase());
      return s ? send(res, 200, s, origin) : send(res, 404, { error: "no sealed record kept for this seal (the relayer keeps the most recent ones in memory)" }, origin);
    }
    if (req.method === "POST" && url.pathname === "/handle") {
      const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
      if (!allow(ip)) return send(res, 429, { error: `The sandbox takes ${PER_IP_PER_HOUR} invoices per hour from one visitor. Try again later.` }, origin);
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8_000) return send(res, 413, { error: "Request too large." }, origin);
      }
      let body;
      try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "The request is not valid JSON." }, origin); }
      const invoice = typeof body.invoice === "string" ? body.invoice.trim() : "";
      const brain = BRAINS().includes(body.brain) ? body.brain : "naive";
      if (!invoice) return send(res, 400, { error: "The invoice is empty." }, origin);
      if (invoice.length > MAX_INVOICE) return send(res, 400, { error: `The invoice is longer than ${MAX_INVOICE} characters.` }, origin);
      // one invoice at a time: the agent has one nonce, and the vault one journal
      const job = queue.then(() => handle(invoice, brain));
      queue = job.catch(() => {});
      return send(res, 200, await job, origin);
    }
    return send(res, 404, { error: "Not found." }, origin);
  } catch (e) {
    console.error(new Date().toISOString(), e.shortMessage || e.message);
    const gas = /insufficient funds|gas/i.test(e.shortMessage || e.message || "");
    return send(res, e.status || 502, { error: e.status ? e.message : gas ? "The sandbox agent is out of testnet gas. The maintainer has to refill it." : "Aevum did not answer in time. Try again in a moment." }, origin);
  }
}).listen(PORT, () => console.log(`sandbox relayer on :${PORT} · agent ${agent.address} · vault ${config().vault ?? "(not set up)"} · brains ${BRAINS().join(", ")}`));
