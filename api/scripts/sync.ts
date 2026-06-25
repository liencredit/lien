/**
 * Populate the configured Supabase with REAL data:
 *   - synthetic seed agents (flagged synthetic:true) so the registry looks alive,
 *   - a batch of real 8004 agents (cluster from LIEN_CLUSTER), scored live.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in the environment (.env).
 *
 * Usage:
 *   npm run sync                 # seed synthetic + 12 real agents
 *   npm run sync -- --wipe       # delete existing rows first (removes demo data)
 *   npm run sync -- --real=20    # pull 20 real agents
 *   npm run sync -- --no-seed    # skip synthetic seed
 */
import { loadConfig } from "../src/config.js";
import { GraphQLClient } from "../src/registry/graphql.js";
import { RegistryReader } from "../src/registry/reader.js";
import { ScoringService } from "../src/service/scoring-service.js";
import { seedStore } from "../src/seed/data.js";
import { SupabaseStore } from "../src/storage/supabase.js";

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function num(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

async function wipe(url: string, serviceKey: string) {
  const base = `${url.replace(/\/$/, "")}/rest/v1`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  // Delete children first in case FKs aren't ON DELETE CASCADE in the target DB.
  for (const table of ["idempotency_keys", "settlements", "scores", "agents"]) {
    const filter = table === "idempotency_keys" ? "key=not.is.null" : "agent_id=not.is.null";
    const res = await fetch(`${base}/${table}?${filter}`, { method: "DELETE", headers });
    console.log(`  wipe ${table}: HTTP ${res.status}`);
  }
}

async function main() {
  const config = loadConfig();
  if (!config.supabase) {
    console.error("SUPABASE_URL + SUPABASE_SERVICE_KEY must be set (.env). Aborting.");
    process.exit(1);
  }

  const store = new SupabaseStore(config.supabase);
  const reader = new RegistryReader(new GraphQLClient({ url: config.graphqlUrl }));
  const scoring = new ScoringService(reader, store);

  console.log(`sync -> ${config.supabase.url} (cluster=${config.cluster})\n`);

  if (flag("wipe")) {
    console.log("wiping existing rows...");
    await wipe(config.supabase.url, config.supabase.serviceKey);
  }

  if (!flag("no-seed")) {
    const r = await seedStore(store);
    console.log(`seeded ${r.agents} synthetic agents, ${r.settlements} settlements`);
  }

  const realN = num("real", 12);
  console.log(`\npulling ${realN} real ${config.cluster} agents...`);
  const agents = await reader.listAgents({ first: realN, orderBy: "totalFeedback" });

  let ok = 0;
  for (const a of agents) {
    try {
      const score = await scoring.refreshAgent(a.id);
      if (score) {
        ok++;
        console.log(`  ${score.agentId.slice(0, 10)}… -> ${score.score} ${score.band} ${score.status}`);
      }
    } catch (e) {
      console.warn(`  ${a.id.slice(0, 10)}… failed: ${(e as Error).message}`);
    }
  }

  console.log(`\ndone: ${ok}/${agents.length} real agents scored + written.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
