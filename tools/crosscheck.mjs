// Cross-check every stored seal with liboqs (C) in addition to @noble/post-quantum (JS).
//   node tools/crosscheck.mjs            (after building tools/verify_liboqs)
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEALS = join(ROOT, "evidence", "seals");
const pk = join(ROOT, "evidence", "agent-pq-public.hex");
const bin = join(ROOT, "tools", "verify_liboqs");
const tmp = mkdtempSync(join(tmpdir(), "seal-"));
let ok = 0, bad = 0;
for (const f of readdirSync(SEALS).filter((f) => f.endsWith(".json"))) {
  const s = JSON.parse(readFileSync(join(SEALS, f), "utf8"));
  writeFileSync(join(tmp, "r"), s.record);
  writeFileSync(join(tmp, "s"), Buffer.from(s.signature, "base64"));
  try {
    const out = execFileSync(bin, [pk, join(tmp, "r"), join(tmp, "s")]).toString().trim();
    ok++;
    console.log(`${f.slice(0, 14)}… ${out}`);
  } catch (e) {
    bad++;
    console.log(`${f.slice(0, 14)}… ${e.stdout?.toString().trim() || e.message}`);
  }
}
console.log(`liboqs: ${ok} valid, ${bad} invalid`);
process.exit(bad ? 1 : 0);
