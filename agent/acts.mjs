// Reads every Act event of a vault, for the sentinel (Node) and the web console (browser).
// The public Aevum RPC caps eth_getLogs at 1,000 blocks (measured 21 Nov 2026) and the chain
// makes about one block per second, so a vault a few days old would need hundreds of calls.
// History therefore comes from the explorer's log index, and only the tail the explorer has not
// indexed yet comes from the RPC. The explorer is not trusted: callers recompute the journal head
// from these events and compare it with the vault's own journalHead, so a missing, extra or altered
// act shows up as a mismatch.
import { decodeEventLog, parseAbiItem, toEventSelector } from "viem";

export const ACT = parseAbiItem(
  "event Act(uint256 indexed index, uint8 indexed kind, address indexed agent, address to, uint256 amount, uint8 code, bytes32 seal, uint256 ref, bytes32 head)",
);
export const EXPLORER = "https://explorer-test.qday.info";
const TOPIC = toEventSelector(ACT);
const RPC_RANGE = 1_000n;

export async function rpcActs(client, address, fromBlock, toBlock, parallel = 6) {
  const ranges = [];
  for (let b = fromBlock; b <= toBlock; b += RPC_RANGE) ranges.push([b, b + RPC_RANGE - 1n > toBlock ? toBlock : b + RPC_RANGE - 1n]);
  const out = [];
  for (let i = 0; i < ranges.length; i += parallel) {
    const part = await Promise.all(ranges.slice(i, i + parallel).map(([a, b]) => client.getLogs({ address, event: ACT, fromBlock: a, toBlock: b })));
    part.forEach((x) => out.push(...x));
  }
  return out;
}

async function explorerActs(address, explorer) {
  // indexed height first: anything the explorer indexes after this point is fetched again from the RPC
  const blocks = await (await fetch(`${explorer}/api/v2/main-page/blocks`)).json();
  const indexedTo = BigInt(blocks[0].height);
  const out = [];
  let query = "";
  for (let page = 0; page < 100; page++) {
    const r = await fetch(`${explorer}/api/v2/addresses/${address}/logs${query}`);
    if (!r.ok) throw new Error(`explorer HTTP ${r.status}`);
    const j = await r.json();
    for (const it of j.items) {
      if (it.topics?.[0] !== TOPIC) continue;
      const { args } = decodeEventLog({ abi: [ACT], data: it.data, topics: it.topics.filter(Boolean) });
      out.push({ args, blockNumber: BigInt(it.block_number), transactionHash: it.transaction_hash ?? it.tx_hash });
    }
    if (!j.next_page_params) break;
    query = "?" + new URLSearchParams(j.next_page_params).toString();
  }
  return { logs: out, indexedTo };
}

/** Every Act of `address` from `fromBlock` to `latest`, sorted by act index. */
export async function readActs(client, address, { fromBlock = 0n, latest, explorer = EXPLORER } = {}) {
  latest ??= await client.getBlockNumber({ cacheTime: 0 }); // viem caches it 4 s otherwise
  let logs = [];
  let tail = fromBlock;
  let source = "rpc";
  if (explorer) {
    try {
      const ex = await explorerActs(address, explorer);
      logs = ex.logs;
      const next = ex.indexedTo - 10n; // small overlap; duplicates are merged by act index below
      if (next > tail) tail = next;
      source = "explorer+rpc";
    } catch {
      // explorer down: the RPC alone still works, only slower
    }
  }
  if (tail <= latest) logs.push(...(await rpcActs(client, address, tail, latest)));
  const byIndex = new Map();
  for (const l of logs) if (l.blockNumber >= fromBlock && l.blockNumber <= latest) byIndex.set(l.args.index, l);
  return { logs: [...byIndex.values()].sort((x, y) => (x.args.index < y.args.index ? -1 : 1)), latest, source };
}
