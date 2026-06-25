/**
 * Generate a self-contained SQL seed for the Lovable-managed Supabase, WITHOUT
 * needing the service-role key. Reuses the exact same record→row mappers as
 * SupabaseStore (so the factor display-scale transform matches the frontend),
 * then serializes to INSERT statements.
 *
 * Output: ../db/seed.sql  (schema-safe + wipe demo rows + insert real data)
 *
 * Usage:
 *   LIEN_CLUSTER=mainnet npm run export:sql            # synthetic + 20 real
 *   LIEN_CLUSTER=mainnet npm run export:sql -- --real=30
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadConfig } from "../src/config.js";
import { GraphQLClient } from "../src/registry/graphql.js";
import { RegistryReader } from "../src/registry/reader.js";
import { ScoringService } from "../src/service/scoring-service.js";
import { seedStore } from "../src/seed/data.js";
import {
  toAgentRow,
  toScoreRow,
  toSettlementRow,
} from "../src/storage/supabase.js";
import { MemoryStore } from "../src/storage/memory.js";
import type {
  AgentRecord,
  IdempotencyRecord,
  ListScoresParams,
  Page,
  ScoreRecord,
  SettlementRecord,
  Store,
} from "../src/storage/types.js";

/** MemoryStore that also records every written record so we can dump them. */
class CapturingStore implements Store {
  private inner = new MemoryStore();
  agents = new Map<string, AgentRecord>();
  scores = new Map<string, ScoreRecord>();
  settlements: SettlementRecord[] = [];

  upsertAgent(a: AgentRecord) {
    this.agents.set(a.agentId, a);
    return this.inner.upsertAgent(a);
  }
  getAgent(id: string) {
    return this.inner.getAgent(id);
  }
  upsertScore(s: ScoreRecord) {
    this.scores.set(s.agentId, s);
    return this.inner.upsertScore(s);
  }
  getScore(id: string) {
    return this.inner.getScore(id);
  }
  listScores(p: ListScoresParams): Promise<Page<ScoreRecord>> {
    return this.inner.listScores(p);
  }
  insertSettlement(s: SettlementRecord) {
    this.settlements.push(s);
    return this.inner.insertSettlement(s);
  }
  getSettlement(id: string) {
    return this.inner.getSettlement(id);
  }
  listSettlementsByAgent(id: string, limit?: number) {
    return this.inner.listSettlementsByAgent(id, limit);
  }
  getIdempotency(key: string) {
    return this.inner.getIdempotency(key);
  }
  putIdempotency(rec: IdempotencyRecord) {
    return this.inner.putIdempotency(rec);
  }
  putAlias(wallet: string, agentId: string) {
    return this.inner.putAlias(wallet, agentId);
  }
  getAlias(wallet: string) {
    return this.inner.getAlias(wallet);
  }
  listAliases(agentId: string) {
    return this.inner.listAliases(agentId);
  }
}

function num(name: string, fallback: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const v = hit ? Number(hit.split("=")[1]) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

// --- SQL literal helpers ---
function sql(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}
function jsonb(v: unknown): string {
  return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
}

function insertAgents(rows: ReturnType<typeof toAgentRow>[]): string {
  if (!rows.length) return "";
  const values = rows
    .map(
      (r) =>
        `  (${sql(r.agent_id)}, ${sql(r.owner)}, ${sql(r.payment_wallet)}, ${sql(r.name)}, ${sql(r.image)}, ${sql(r.first_seen)}, ${sql(r.synthetic)})`,
    )
    .join(",\n");
  return `insert into agents (agent_id, owner, payment_wallet, name, image, first_seen, synthetic) values\n${values}\non conflict (agent_id) do update set owner=excluded.owner, payment_wallet=excluded.payment_wallet, name=excluded.name, image=excluded.image, first_seen=excluded.first_seen, synthetic=excluded.synthetic;\n`;
}

function insertScores(rows: ReturnType<typeof toScoreRow>[]): string {
  if (!rows.length) return "";
  const values = rows
    .map(
      (r) =>
        `  (${sql(r.agent_id)}, ${sql(r.score)}, ${sql(r.band)}, ${sql(r.status)}, ${sql(r.limit_amount)}, ${sql(r.limit_currency)}, ${sql(r.limit_period)}, ${sql(r.attested)}, ${jsonb(r.factors)}, ${sql(r.updated_at)})`,
    )
    .join(",\n");
  return `insert into scores (agent_id, score, band, status, limit_amount, limit_currency, limit_period, attested, factors, updated_at) values\n${values}\non conflict (agent_id) do update set score=excluded.score, band=excluded.band, status=excluded.status, limit_amount=excluded.limit_amount, limit_currency=excluded.limit_currency, limit_period=excluded.limit_period, attested=excluded.attested, factors=excluded.factors, updated_at=excluded.updated_at;\n`;
}

function insertSettlements(rows: ReturnType<typeof toSettlementRow>[]): string {
  if (!rows.length) return "";
  const values = rows
    .map(
      (r) =>
        `  (${sql(r.id)}, ${sql(r.agent_id)}, ${sql(r.tab_id)}, ${sql(r.counterparty)}, ${sql(r.amount)}, ${sql(r.currency)}, ${sql(r.status)}, ${sql(r.on_time)}, ${sql(r.occurred_at)})`,
    )
    .join(",\n");
  return `insert into settlements (id, agent_id, tab_id, counterparty, amount, currency, status, on_time, occurred_at) values\n${values}\non conflict (id) do nothing;\n`;
}

async function main() {
  const cfg = loadConfig();
  const store = new CapturingStore();
  const reader = new RegistryReader(new GraphQLClient({ url: cfg.graphqlUrl }));
  const scoring = new ScoringService(reader, store);

  const seed = await seedStore(store);
  const realN = num("real", 20);

  console.error(`seeded ${seed.agents} synthetic; pulling ${realN} real ${cfg.cluster} agents...`);
  const agents = await reader.listAgents({ first: realN, orderBy: "totalFeedback" });
  let ok = 0;
  for (const a of agents) {
    try {
      const s = await scoring.refreshAgent(a.id);
      if (s) ok++;
    } catch (e) {
      console.error(`  ${a.id.slice(0, 10)}… failed: ${(e as Error).message}`);
    }
  }
  console.error(`scored ${ok}/${agents.length} real agents`);

  const agentRows = [...store.agents.values()].map(toAgentRow);
  const scoreRows = [...store.scores.values()].map(toScoreRow);
  const settlementRows = store.settlements.map(toSettlementRow);

  const out = `-- LIEN seed data — generated by api/scripts/export-sql.ts
-- cluster=${cfg.cluster}  generated_at=${new Date().toISOString()}
-- ${agentRows.length} agents (${scoreRows.length} scored), ${settlementRows.length} settlements.
-- Synthetic agents are flagged synthetic=true; real on-chain agents are synthetic=false.
-- Safe to re-run: tables are created if missing, demo rows wiped, data upserted.

begin;

-- 1. Ensure schema exists (no-op if Lovable already created these tables).
create table if not exists agents (
  agent_id text primary key, owner text not null, payment_wallet text,
  name text, image text, first_seen timestamptz not null default now(),
  synthetic boolean not null default false
);
create table if not exists scores (
  agent_id text primary key references agents(agent_id) on delete cascade,
  score integer not null, band text not null, status text not null,
  limit_amount bigint, limit_currency text, limit_period text,
  attested boolean not null default false,
  factors jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
create table if not exists settlements (
  id text primary key,
  agent_id text not null references agents(agent_id) on delete cascade,
  tab_id text, counterparty text, amount bigint not null,
  currency text not null default 'USDC', status text not null,
  on_time boolean not null, occurred_at timestamptz not null default now()
);

-- 2. Wipe existing demo rows (children first for FK safety).
delete from settlements;
delete from scores;
delete from agents;

-- 3. Insert canonical data.
${insertAgents(agentRows)}
${insertScores(scoreRows)}
${insertSettlements(settlementRows)}
commit;
`;

  const here = dirname(fileURLToPath(import.meta.url));
  const target = resolve(here, "../../db/seed.sql");
  writeFileSync(target, out, "utf8");
  console.error(`\nwrote ${target}  (${out.length} bytes)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
