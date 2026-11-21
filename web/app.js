// ImmuneVault console: reads the vault on Aevum, replays the journal, and verifies
// every ML-DSA-65 seal in the browser. With MetaMask, the owner can revoke, pardon,
// approve or reject held payments.
import { createPublicClient, createWalletClient, custom, http, defineChain, parseAbiItem, keccak256, concat, encodeAbiParameters } from "viem";
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";
import { ACT, readActs } from "../agent/acts.mjs";

const aevum = defineChain({
  id: 44005, name: "QDay Aevum Testnet",
  nativeCurrency: { name: "tQDAY", symbol: "tQDAY", decimals: 18 },
  rpcUrls: { default: { http: [new URLSearchParams(location.search).get("rpc") || "https://rpc-test.qday.info"] } },
  blockExplorers: { default: { name: "Aevum Explorer", url: "https://explorer-test.qday.info" } },
});
const EXP = aevum.blockExplorers.default.url;
const Q = new URLSearchParams(location.search);
const DATA = Q.get("data") || "../evidence/";
// history from the explorer index (the public RPC serves 1,000 blocks per log query); not with a custom RPC
const EXPLORER_API = Q.get("explorer") ?? (Q.get("rpc") ? null : EXP);
const CODES = ["OK", "REVOKED", "EXPIRED", "QUARANTINED", "OVER_TX_CAP", "OVER_DAILY_CAP", "UNKNOWN_RECIPIENT", "INSUFFICIENT_FUNDS", "HELD_FOR_REVIEW", "MISSING_SEAL", "BAD_ESCROW_TERMS"];
const KINDS = { 1: "pay", 2: "lock", 3: "release", 4: "refund", 5: "approve", 6: "reject" };
const abi = [
  ACT,
  ...["function journalHead() view returns (bytes32)", "function actCount() view returns (uint256)", "function lockedTotal() view returns (uint256)",
    "function available() view returns (uint256)", "function owner() view returns (address)", "function heldCount() view returns (uint256)",
    "function sessions(address) view returns (uint128 perTxCap, uint128 dailyCap, uint64 validUntil, bool active, bytes32 pqKeyHash)",
    "function health(address) view returns (uint64 windowStart, uint128 spentInWindow, uint32 strikes, uint64 quarantinedUntil)",
    "function held(uint256) view returns (address agent, address to, uint128 amount, bytes32 seal, bool open)",
    "function revokeSession(address)", "function pardon(address)", "function approve(uint256)", "function reject(uint256)"].map(parseAbiItem),
];
const client = createPublicClient({ chain: aevum, transport: http() });
const $ = (s) => document.querySelector(s);
const usd = (v) => (Number(v) / 1e6).toFixed(2);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
let dep, names = {}, pub;

async function load() {
  dep = await (await fetch(`${DATA}deployment.json`)).json();
  names = Object.fromEntries(Object.entries(dep.addresses).map(([k, v]) => [v.toLowerCase(), k]));
  const hex = (await (await fetch(`${DATA}agent-pq-public.hex`)).text()).trim();
  pub = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
  $("#vault").innerHTML = `<a href="${EXP}/address/${dep.vault}" target="_blank" rel="noopener">${dep.vault}</a>`;
  await refresh();
}

async function refresh() {
  $("#status").textContent = "reading Aevum…";
  const v = dep.vault, agent = dep.addresses.agent;
  const [head, count, locked, avail, s, h, heldN] = await Promise.all([
    client.readContract({ address: v, abi, functionName: "journalHead" }),
    client.readContract({ address: v, abi, functionName: "actCount" }),
    client.readContract({ address: v, abi, functionName: "lockedTotal" }),
    client.readContract({ address: v, abi, functionName: "available" }),
    client.readContract({ address: v, abi, functionName: "sessions", args: [agent] }),
    client.readContract({ address: v, abi, functionName: "health", args: [agent] }),
    client.readContract({ address: v, abi, functionName: "heldCount" }),
  ]);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const state = !s[3] ? ["revoked", "bad"] : now > s[2] ? ["expired", "bad"] : h[3] > now ? ["quarantined", "warn"] : ["active", "good"];
  $("#agentState").className = `pill ${state[1]}`;
  $("#agentState").textContent = state[0];
  $("#caps").textContent = `${usd(s[0])} per payment · ${usd(s[1])} per 24 h · spent ${usd(h[1])} · strikes ${h[2]} · valid until ${new Date(Number(s[2]) * 1000).toLocaleString()}`;
  $("#funds").textContent = `${usd(avail)} tUSD8 available · ${usd(locked)} locked (escrow + review)`;
  $("#pqkey").textContent = `${keccak256(pub) === s[4] ? "matches" : "DOES NOT MATCH"} the session's pqKeyHash`;

  // held payments
  const rows = [];
  for (let i = 0n; i < heldN; i++) {
    const p = await client.readContract({ address: v, abi, functionName: "held", args: [i] });
    if (p[4]) rows.push(`<li>#${i} ${usd(p[2])} tUSD8 → ${names[p[1].toLowerCase()] ?? short(p[1])} <button data-a="approve" data-i="${i}">approve</button> <button data-a="reject" data-i="${i}">reject</button></li>`);
  }
  $("#held").innerHTML = rows.join("") || "<li>none</li>";

  // journal + seals
  const { logs, latest } = await readActs(client, v, { fromBlock: BigInt(dep.fromBlock), explorer: EXPLORER_API });
  let replay = "0x" + "00".repeat(32);
  // block timestamps and seal checks in parallel, the replay itself stays sequential
  $("#status").textContent = `reading ${logs.length} acts…`;
  const blocks = [...new Set(logs.map((l) => l.blockNumber))];
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, (await client.getBlock({ blockNumber: b })).timestamp])));
  $("#status").textContent = `verifying ${logs.length} ML-DSA-65 seals…`;
  const seals = await Promise.all(logs.map((l) => checkSeal(l.args)));
  const tr = [];
  logs.forEach((l, i) => {
    const a = l.args;
    replay = keccak256(encodeAbiParameters(
      ["bytes32", "uint256", "uint8", "address", "address", "uint256", "uint8", "bytes32", "uint256", "uint256"].map((type) => ({ type })),
      [replay, a.index, a.kind, a.agent, a.to, a.amount, a.code, a.seal, a.ref, times.get(l.blockNumber)]));
    const code = CODES[a.code];
    tr.push(`<tr class="${code === "OK" ? "" : code === "HELD_FOR_REVIEW" ? "warn" : "bad"}"><td>${a.index}</td><td>${KINDS[a.kind]}</td>
      <td>${names[a.to.toLowerCase()] ?? short(a.to)}</td><td class="num">${usd(a.amount)}</td><td>${code}</td><td>${seals[i]}</td>
      <td><a href="${EXP}/tx/${l.transactionHash}" target="_blank" rel="noopener">${l.transactionHash.slice(0, 10)}…</a></td></tr>`);
  });
  $("#journal tbody").innerHTML = tr.reverse().join("");
  $("#head").innerHTML = `${count} acts · on-chain head <code>${head.slice(0, 18)}…</code> · replayed in this browser: <b class="${replay === head ? "ok" : "ko"}">${replay === head ? "matches" : "MISMATCH"}</b>`;
  $("#status").textContent = `read at block ${latest}`;
}

async function checkSeal(a) {
  const kind = KINDS[a.kind];
  if (kind !== "pay" && kind !== "lock") return "—";
  try {
    const r = await fetch(`${DATA}seals/${a.seal}.json`);
    if (!r.ok) return CODES[a.code] === "OK" || CODES[a.code] === "HELD_FOR_REVIEW" ? `<b class="ko">no sealed record</b>` : "no record (refused)";
    const s = await r.json();
    const rec = new TextEncoder().encode(s.record);
    const sig = Uint8Array.from(atob(s.signature), (c) => c.charCodeAt(0));
    if (keccak256(concat([rec, sig])) !== a.seal) return `<b class="ko">seal ≠ record</b>`;
    const ok = ml_dsa65.verify(sig, rec, pub);
    const j = JSON.parse(s.record);
    const same = j.to.toLowerCase() === a.to.toLowerCase() && j.amount === a.amount.toString();
    return ok && same ? `<b class="ok">ML-DSA-65 ✓</b>` : `<b class="ko">${ok ? "record ≠ act" : "signature ✗"}</b>`;
  } catch (e) {
    return `<b class="ko">${e.message}</b>`;
  }
}

async function ownerCall(fn, args) {
  if (!window.ethereum) return alert("MetaMask (or another EIP-1193 wallet) is needed for owner actions.");
  const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
  try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xabe5" }] }); }
  catch { await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: "0xabe5", chainName: aevum.name, nativeCurrency: aevum.nativeCurrency, rpcUrls: aevum.rpcUrls.default.http, blockExplorerUrls: [EXP] }] }); }
  const w = createWalletClient({ account: addr, chain: aevum, transport: custom(window.ethereum) });
  $("#status").textContent = `${fn}: waiting for signature…`;
  const hash = await w.writeContract({ address: dep.vault, abi, functionName: fn, args });
  $("#status").innerHTML = `${fn}: <a href="${EXP}/tx/${hash}" target="_blank" rel="noopener">${hash.slice(0, 12)}…</a> confirming…`;
  await client.waitForTransactionReceipt({ hash });
  await refresh();
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-a]");
  if (!b) return;
  const a = b.dataset.a;
  if (a === "revoke") ownerCall("revokeSession", [dep.addresses.agent]).catch((x) => ($("#status").textContent = x.shortMessage ?? x.message));
  if (a === "pardon") ownerCall("pardon", [dep.addresses.agent]).catch((x) => ($("#status").textContent = x.shortMessage ?? x.message));
  if (a === "approve" || a === "reject") ownerCall(a, [BigInt(b.dataset.i)]).catch((x) => ($("#status").textContent = x.shortMessage ?? x.message));
  if (a === "refresh") refresh();
});
load().catch((e) => ($("#status").textContent = e.message));
