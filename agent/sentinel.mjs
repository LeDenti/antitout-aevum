// The sentinel: reads every Act of the vault, checks its ML-DSA-65 seal off-chain,
// recomputes the journal head, and freezes the agent (guardian role: revoke only,
// never move funds) as soon as an accepted act carries a seal that does not verify.
// This is the off-chain half of a hybrid check (ECDSA on-chain + ML-DSA-65 seal),
// until QDay Phase 2 ships its ML-DSA-65 precompile and `payVerified` takes over.
//   node sentinel.mjs <vault> [--once] [--from <block>]
import { encodeAbiParameters, keccak256, parseAbiItem } from "viem";
import { publicClient, wallet, artifact, verifySeal, pqKeys, CODES, KINDS, explorerTx } from "./common.mjs";

const ACT = parseAbiItem(
  "event Act(uint256 indexed index, uint8 indexed kind, address indexed agent, address to, uint256 amount, uint8 code, bytes32 seal, uint256 ref, bytes32 head)",
);

export async function scan(vault, { fromBlock = 0n, act = true, log = console.log } = {}) {
  const { abi } = artifact();
  const logs = await getLogsChunked(vault, fromBlock);
  const { publicKey } = pqKeys();
  let head = "0x" + "00".repeat(32);
  const findings = [];
  const blockTimes = new Map();
  for (const l of logs) {
    const a = l.args;
    // 1. journal integrity: recompute the head exactly as the contract does
    if (!blockTimes.has(l.blockNumber)) blockTimes.set(l.blockNumber, (await publicClient.getBlock({ blockNumber: l.blockNumber })).timestamp);
    head = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
        [head, a.index, a.kind, a.agent, a.to, a.amount, a.code, a.seal, a.ref, blockTimes.get(l.blockNumber)],
      ),
    );
    if (head !== a.head) findings.push({ index: a.index, problem: "journal head mismatch", tx: l.transactionHash });
    // 2. seals: every act the agent initiated (pay / lock) that the vault accepted
    const kind = KINDS[a.kind];
    const accepted = CODES[a.code] === "OK" || CODES[a.code] === "HELD_FOR_REVIEW";
    if ((kind === "pay" || kind === "lock") && accepted) {
      const v = verifySeal(a.seal, publicKey, { to: a.to, amount: a.amount, agent: a.agent, vault, kind });
      if (!v.ok) findings.push({ index: a.index, agent: a.agent, problem: `forged seal: ${v.why}`, tx: l.transactionHash });
    }
  }
  const onchain = await publicClient.readContract({ address: vault, abi, functionName: "journalHead" });
  const headOk = onchain === head;
  log(`sentinel: ${logs.length} acts, journal head ${headOk ? "matches" : "DOES NOT MATCH"} chain (${onchain.slice(0, 18)}…)`);

  const frozen = [];
  for (const f of findings) {
    log(`sentinel: act #${f.index} ${f.problem}  ${explorerTx(f.tx)}`);
    if (!act || !f.agent) continue;
    const s = await publicClient.readContract({ address: vault, abi, functionName: "sessions", args: [f.agent] });
    if (!s[3]) continue; // already revoked
    const hash = await wallet("guardian").writeContract({ address: vault, abi, functionName: "revokeSession", args: [f.agent] });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    log(`sentinel: agent ${f.agent} FROZEN by guardian (block ${r.blockNumber})  ${explorerTx(hash)}`);
    frozen.push({ agent: f.agent, hash, block: r.blockNumber, act: f });
  }
  return { acts: logs.length, headOk, findings, frozen };
}

async function getLogsChunked(address, fromBlock) {
  const latest = await publicClient.getBlockNumber({ cacheTime: 0 }); // viem caches it 4 s otherwise
  const out = [];
  const step = 9_000n;
  for (let b = fromBlock; b <= latest; b += step + 1n) {
    const to = b + step > latest ? latest : b + step;
    out.push(...(await publicClient.getLogs({ address, event: ACT, fromBlock: b, toBlock: to })));
  }
  return out.sort((x, y) => (x.args.index < y.args.index ? -1 : 1));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const vault = process.argv[2];
  const fi = process.argv.indexOf("--from");
  const fromBlock = fi > 0 ? BigInt(process.argv[fi + 1]) : 0n;
  const once = process.argv.includes("--once");
  do {
    await scan(vault, { fromBlock });
    if (!once) await new Promise((r) => setTimeout(r, 5000));
  } while (!once);
}
