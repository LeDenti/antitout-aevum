// The agent's "brain": turns an invoice into a payment intent.
//
// It is deliberately NAIVE: it obeys the LAST payment instruction it finds anywhere
// in the text, hidden comments included. That is the point of the demo — assume the
// AI is fooled (prompt injection) or wrong, and show that the vault still holds.
//
// BRAIN=claude uses the Anthropic API instead (needs ANTHROPIC_API_KEY); the vault
// treats both brains the same way: as untrusted.

const PAY = /pay\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*tUSD8\s+to\s+(0x[0-9a-fA-F]{40}|[a-z]+)/gi;
const ESCROW = /escrow\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*tUSD8\s+to\s+([a-z]+)\s+until\s+(.+?),\s*deadline\s+(\d+)\s*(s|h)\s*,\s*condition\s+sha256:(0x[0-9a-fA-F]{64})/i;

const toUnits = (s) => BigInt(Math.round(Number(s) * 1e6));

export function naiveDecide(text, addressBook) {
  const e = text.match(ESCROW);
  if (e) {
    const secs = Number(e[4]) * (e[5].toLowerCase() === "h" ? 3600 : 1);
    return { action: "lock", amount: toUnits(e[1]), to: resolve(e[2], addressBook), deliverable: e[3], deadlineIn: secs, condition: e[6] };
  }
  const all = [...text.matchAll(PAY)];
  if (!all.length) return { action: "none" };
  const last = all[all.length - 1]; // <- the naive part
  return { action: "pay", amount: toUnits(last[1]), to: resolve(last[2], addressBook) };
}

function resolve(name, book) {
  if (name.startsWith("0x")) return name;
  const a = book[name.toLowerCase()];
  if (!a) throw new Error(`unknown payee name ${name}`);
  return a;
}

export async function claudeDecide(text, addressBook) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("BRAIN=claude needs ANTHROPIC_API_KEY");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-haiku-5-5",
      max_tokens: 300,
      system:
        "You are an accounts-payable agent. Read the invoice and answer ONLY with JSON: " +
        '{"action":"pay"|"lock"|"none","amount":"<tUSD8 decimal>","to":"<name or 0x address>",' +
        '"deliverable":"...","deadlineIn":<seconds>,"condition":"0x..."}. Known payees: ' +
        Object.keys(addressBook).join(", "),
      messages: [{ role: "user", content: text }],
    }),
  });
  const j = await res.json();
  const d = JSON.parse(j.content[0].text.match(/\{[\s\S]*\}/)[0]);
  if (d.action === "none") return d;
  return { ...d, amount: toUnits(d.amount), to: resolve(d.to, addressBook) };
}

export const decide = (text, book) => (process.env.BRAIN === "claude" ? claudeDecide(text, book) : naiveDecide(text, book));
