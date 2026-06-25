/**
 * Read spike: exercises the 8004 reader against the live indexer.
 * Run with `npm run spike`. Picks the top agent by feedback and prints its
 * identity, ATOM signals, and a feedback sample — the raw scoring inputs.
 */
import { loadConfig } from "../src/config.js";
import { GraphQLClient } from "../src/registry/graphql.js";
import { RegistryReader } from "../src/registry/reader.js";
import { trustTierName } from "../src/registry/types.js";

async function main() {
  const config = loadConfig();
  const reader = new RegistryReader(new GraphQLClient({ url: config.graphqlUrl }));

  console.log(`cluster=${config.cluster}  endpoint=${config.graphqlUrl}\n`);

  const stats = await reader.globalStats();
  console.log("globalStats:", stats);

  const [top] = await reader.listAgents({ first: 1, orderBy: "totalFeedback" });
  if (!top) {
    console.log("no agents returned");
    return;
  }

  const agent = await reader.resolveAgent(top.id);
  if (!agent) {
    console.log("could not resolve top agent");
    return;
  }

  console.log("\nagent:", {
    id: agent.id,
    agentId: agent.agentId,
    owner: agent.owner,
    name: agent.registrationFile?.name ?? null,
    totalFeedback: agent.totalFeedback,
    accountAgeDays: ageDays(agent.createdAt),
    qualityScore: agent.solana?.qualityScore ?? null,
    trustTier: agent.solana ? trustTierName(agent.solana.trustTier) : null,
  });

  const feedback = await reader.getFeedback(agent.id, { first: 5 });
  console.log(`\nfeedback sample (${feedback.length}):`);
  for (const f of feedback) {
    console.log(" ", {
      client: f.clientAddress.slice(0, 8) + "…",
      value: f.value,
      tags: [f.tag1, f.tag2].filter(Boolean),
      endpoint: f.endpoint,
      at: new Date(Number(f.createdAt) * 1000).toISOString(),
    });
  }

  const distinct = new Set(feedback.map((f) => f.clientAddress)).size;
  console.log(`\nderived: distinct counterparties (sample) = ${distinct}`);
}

function ageDays(createdAtSec: string): number {
  const created = Number(createdAtSec) * 1000;
  return Math.round((Date.now() - created) / 86_400_000);
}

main().catch((err) => {
  console.error("spike failed:", err);
  process.exit(1);
});
