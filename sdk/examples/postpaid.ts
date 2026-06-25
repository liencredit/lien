/**
 * Post-paid demo — the launch loop.
 *
 *   check score → open tab → meter usage → settle net → report outcome → re-score
 *
 * Run the API first (cd ../api && npm run dev), then: `npm run demo`.
 * Override the target via: `npm run demo -- <agent_id>`.
 */
import { Lien, LienError } from "../src/index.js";

const BASE_URL = process.env.LIEN_BASE_URL ?? "http://127.0.0.1:8787/v1";
const API_KEY = process.env.LIEN_API_KEY ?? "sk_test_demo";

const lien = new Lien({ apiKey: API_KEY, baseUrl: BASE_URL });

const usdc = (minor: number) => `${(minor / 1_000_000).toLocaleString()} USDC`;
const line = () => console.log("─".repeat(60));

async function runProvider(agentId: string) {
  line();
  console.log(`provider session for ${agentId}`);
  line();

  // 1. Check standing before extending any credit.
  let credit;
  try {
    credit = await lien.check(agentId);
  } catch (e) {
    if (e instanceof LienError && e.type === "agent_not_registered") {
      console.log("✗ no 8004 identity → require prepay, stop.\n");
      return;
    }
    throw e;
  }

  console.log(`score ${credit.score} (${credit.band}) — ${credit.status}`);

  if (credit.status === "defaulted" || !credit.limit) {
    console.log("✗ defaulted or no limit → require prepay, stop.\n");
    return;
  }

  // 2. Open a tab against the recommended ceiling.
  const ceiling = credit.limit.amount;
  console.log(`✓ open tab — ceiling ${usdc(ceiling)} / ${credit.limit.period}`);

  // 3. Meter usage over the period (simulated: 8 metered calls).
  let accrued = 0;
  const pricePerCall = Math.round(ceiling / 20);
  for (let i = 0; i < 8; i++) {
    if (accrued + pricePerCall > ceiling) {
      console.log("  · ceiling reached — throttling further usage");
      break;
    }
    accrued += pricePerCall;
  }
  console.log(`  metered usage: ${usdc(accrued)} across the period`);

  // 4. Settle net (one aggregated payment via your rail / x402).
  const onTime = true;
  const tabId = `tab_${Date.now()}`;
  console.log(`✓ settle net ${usdc(accrued)} (on_time=${onTime})`);

  // 5. Report the outcome so it feeds the next score.
  const settlement = await lien.settlements.create(
    { agent_id: agentId, tab_id: tabId, amount: accrued, on_time: onTime },
    { idempotencyKey: tabId },
  );
  console.log(`  recorded settlement ${settlement.id} → ${settlement.status}`);

  // 6. Re-check — the outcome is now part of the agent's history.
  const after = await lien.check(agentId);
  console.log(`re-scored: ${after.score} (${after.band}) — ${after.status}\n`);
}

async function main() {
  const target = process.argv[2];
  const agents = target
    ? [target]
    : [
        "agent:sol:7xKq9b9c4Atlas", // excellent → opens a tab
        "agent:sol:8pLkharborDef", // defaulted → require prepay
      ];

  console.log(`\nLIEN post-paid demo · ${BASE_URL}\n`);
  for (const a of agents) await runProvider(a);
}

main().catch((e) => {
  if (e instanceof LienError) {
    console.error(`\nLienError ${e.status} ${e.type}: ${e.message}`);
    console.error("is the API running?  cd ../api && npm run dev");
  } else {
    console.error(e);
  }
  process.exit(1);
});
