// Recover funds from a vault of an interrupted run: refund open escrows after their
// deadline, then withdraw what is available back to the owner.
//   node recover.mjs <vault>
import { publicClient, wallet, account, artifact, fmt, explorerTx } from "./common.mjs";
const vault = process.argv[2];
const { abi } = artifact();
const n = await publicClient.readContract({ address: vault, abi, functionName: "escrowCount" });
for (let i = 0n; i < n; i++) {
  const e = await publicClient.readContract({ address: vault, abi, functionName: "escrows", args: [i] });
  if (e[5] !== 1) continue;
  while ((await publicClient.getBlock()).timestamp < e[3]) await new Promise((r) => setTimeout(r, 5000));
  const hash = await wallet("owner").writeContract({ address: vault, abi, functionName: "refund", args: [i] });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`refund escrow #${i} ${fmt(e[2])}  ${explorerTx(hash)}`);
}
const avail = await publicClient.readContract({ address: vault, abi, functionName: "available" });
if (avail > 0n) {
  const hash = await wallet("owner").writeContract({ address: vault, abi, functionName: "withdraw", args: [account("owner").address, avail] });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`withdraw ${fmt(avail)} to owner  ${explorerTx(hash)}`);
}
