import pg from "pg";
import { clampLimit, sortAndPaginate } from "./query.js";
import type {
  AgentRecord,
  Factor,
  IdempotencyRecord,
  Limit,
  ListScoresParams,
  Page,
  ScoreRecord,
  SettlementRecord,
  Store,
} from "./types.js";

const { Pool } = pg;

// pg returns BIGINT/INT8 (oid 20) as strings to avoid precision loss. Our amounts
// (USDC minor units) stay well within Number.MAX_SAFE_INTEGER, so parse to number.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id      text PRIMARY KEY,
  owner         text NOT NULL,
  payment_wallet text,
  name          text,
  image         text,
  first_seen    timestamptz NOT NULL,
  synthetic     boolean NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS scores (
  agent_id       text PRIMARY KEY,
  score          integer NOT NULL,
  band           text NOT NULL,
  status         text NOT NULL,
  limit_amount   bigint,
  limit_currency text,
  limit_period   text,
  attested       boolean NOT NULL DEFAULT false,
  factors        jsonb NOT NULL DEFAULT '[]',
  updated_at     timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS settlements (
  id          text PRIMARY KEY,
  agent_id    text NOT NULL,
  tab_id      text,
  counterparty text,
  amount      bigint NOT NULL,
  currency    text NOT NULL,
  status      text NOT NULL,
  on_time     boolean NOT NULL,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS settlements_agent_idx ON settlements (agent_id, occurred_at DESC);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           text PRIMARY KEY,
  request_hash  text NOT NULL,
  settlement_id text NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  wallet     text PRIMARY KEY,
  agent_id   text NOT NULL,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS aliases_agent_idx ON aliases (agent_id);
`;

interface ScoreRow {
  agent_id: string;
  score: number;
  band: ScoreRecord["band"];
  status: ScoreRecord["status"];
  limit_amount: number | null;
  limit_currency: string | null;
  limit_period: Limit["period"] | null;
  attested: boolean;
  factors: Factor[];
  updated_at: Date;
}

interface AgentRow {
  agent_id: string;
  owner: string;
  payment_wallet: string | null;
  name: string | null;
  image: string | null;
  first_seen: Date;
  synthetic: boolean;
}

interface SettlementRow {
  id: string;
  agent_id: string;
  tab_id: string | null;
  counterparty: string | null;
  amount: number;
  currency: string;
  status: SettlementRecord["status"];
  on_time: boolean;
  occurred_at: Date;
}

const iso = (d: Date | string): string => (typeof d === "string" ? d : d.toISOString());

function toScoreRecord(r: ScoreRow): ScoreRecord {
  const limit: Limit | null =
    r.limit_amount !== null && r.limit_currency !== null && r.limit_period !== null
      ? { amount: r.limit_amount, currency: r.limit_currency, period: r.limit_period }
      : null;
  return {
    agentId: r.agent_id,
    score: r.score,
    band: r.band,
    status: r.status,
    limit,
    attested: r.attested,
    factors: r.factors ?? [],
    updatedAt: iso(r.updated_at),
  };
}

/**
 * Postgres-backed Store. Durable across restarts — this is what lets the x402
 * settlement ledger accumulate. Stores the canonical engine `Factor` directly as
 * jsonb (no frontend display transform; that adapter lives in SupabaseStore).
 */
export class PostgresStore implements Store {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    const ssl = /railway\.internal|localhost|127\.0\.0\.1/.test(connectionString)
      ? undefined
      : { rejectUnauthorized: false };
    this.pool = new Pool({ connectionString, ssl, max: 5 });
  }

  /** Create tables if absent. Safe to call on every boot. */
  async init(): Promise<void> {
    await this.pool.query(SCHEMA);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertAgent(a: AgentRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (agent_id, owner, payment_wallet, name, image, first_seen, synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (agent_id) DO UPDATE SET
         owner=EXCLUDED.owner, payment_wallet=EXCLUDED.payment_wallet, name=EXCLUDED.name,
         image=EXCLUDED.image, first_seen=EXCLUDED.first_seen, synthetic=EXCLUDED.synthetic`,
      [a.agentId, a.owner, a.paymentWallet, a.name, a.image, a.firstSeen, a.synthetic],
    );
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    const { rows } = await this.pool.query<AgentRow>(
      `SELECT * FROM agents WHERE agent_id=$1 LIMIT 1`,
      [agentId],
    );
    const r = rows[0];
    return r
      ? {
          agentId: r.agent_id,
          owner: r.owner,
          paymentWallet: r.payment_wallet,
          name: r.name,
          image: r.image,
          firstSeen: iso(r.first_seen),
          synthetic: r.synthetic,
        }
      : null;
  }

  async upsertScore(s: ScoreRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO scores (agent_id, score, band, status, limit_amount, limit_currency, limit_period, attested, factors, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (agent_id) DO UPDATE SET
         score=EXCLUDED.score, band=EXCLUDED.band, status=EXCLUDED.status,
         limit_amount=EXCLUDED.limit_amount, limit_currency=EXCLUDED.limit_currency,
         limit_period=EXCLUDED.limit_period, attested=EXCLUDED.attested,
         factors=EXCLUDED.factors, updated_at=EXCLUDED.updated_at`,
      [
        s.agentId,
        s.score,
        s.band,
        s.status,
        s.limit?.amount ?? null,
        s.limit?.currency ?? null,
        s.limit?.period ?? null,
        s.attested,
        JSON.stringify(s.factors),
        s.updatedAt,
      ],
    );
  }

  async getScore(agentId: string): Promise<ScoreRecord | null> {
    const { rows } = await this.pool.query<ScoreRow>(
      `SELECT * FROM scores WHERE agent_id=$1 LIMIT 1`,
      [agentId],
    );
    return rows[0] ? toScoreRecord(rows[0]) : null;
  }

  async listScores(params: ListScoresParams): Promise<Page<ScoreRecord>> {
    // Status/synthetic filtered in SQL; sort/cursor applied in-process so every
    // backend agrees. LEFT JOIN keeps scores whose agent row is absent.
    const where: string[] = [];
    const args: unknown[] = [];
    if (params.status) {
      args.push(params.status);
      where.push(`s.status=$${args.length}`);
    }
    if (params.excludeSynthetic) {
      where.push(`COALESCE(a.synthetic, false) = false`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await this.pool.query<ScoreRow>(
      `SELECT s.* FROM scores s
       LEFT JOIN agents a ON a.agent_id = s.agent_id
       ${clause}
       ORDER BY s.score DESC LIMIT 1000`,
      args,
    );
    return sortAndPaginate(rows.map(toScoreRecord), params);
  }

  async insertSettlement(s: SettlementRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO settlements (id, agent_id, tab_id, counterparty, amount, currency, status, on_time, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [s.id, s.agentId, s.tabId, s.counterparty, s.amount, s.currency, s.status, s.onTime, s.occurredAt],
    );
  }

  async getSettlement(id: string): Promise<SettlementRecord | null> {
    const { rows } = await this.pool.query<SettlementRow>(
      `SELECT * FROM settlements WHERE id=$1 LIMIT 1`,
      [id],
    );
    return rows[0] ? this.toSettlement(rows[0]) : null;
  }

  async listSettlementsByAgent(agentId: string, limit = 50): Promise<SettlementRecord[]> {
    const n = clampLimit(limit, 50);
    const { rows } = await this.pool.query<SettlementRow>(
      `SELECT * FROM settlements WHERE agent_id=$1 ORDER BY occurred_at DESC LIMIT $2`,
      [agentId, n],
    );
    return rows.map((r) => this.toSettlement(r));
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.pool.query<{ key: string; request_hash: string; settlement_id: string }>(
      `SELECT * FROM idempotency_keys WHERE key=$1 LIMIT 1`,
      [key],
    );
    const r = rows[0];
    return r ? { key: r.key, requestHash: r.request_hash, settlementId: r.settlement_id } : null;
  }

  async putIdempotency(rec: IdempotencyRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO idempotency_keys (key, request_hash, settlement_id) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO NOTHING`,
      [rec.key, rec.requestHash, rec.settlementId],
    );
  }

  async putAlias(wallet: string, agentId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO aliases (wallet, agent_id) VALUES ($1,$2)
       ON CONFLICT (wallet) DO UPDATE SET agent_id=EXCLUDED.agent_id, linked_at=now()`,
      [wallet, agentId],
    );
  }

  async getAlias(wallet: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ agent_id: string }>(
      `SELECT agent_id FROM aliases WHERE wallet=$1 LIMIT 1`,
      [wallet],
    );
    return rows[0]?.agent_id ?? null;
  }

  async listAliases(agentId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ wallet: string }>(
      `SELECT wallet FROM aliases WHERE agent_id=$1`,
      [agentId],
    );
    return rows.map((r) => r.wallet);
  }

  private toSettlement(r: SettlementRow): SettlementRecord {
    return {
      id: r.id,
      agentId: r.agent_id,
      tabId: r.tab_id,
      counterparty: r.counterparty,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      onTime: r.on_time,
      occurredAt: iso(r.occurred_at),
    };
  }
}
