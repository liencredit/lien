import { clampLimit, sortAndPaginate } from "./query.js";
import type {
  AgentRecord,
  Band,
  Factor,
  IdempotencyRecord,
  Limit,
  ListScoresParams,
  Page,
  Period,
  ScoreRecord,
  SettlementRecord,
  SettlementStatus,
  Status,
  Store,
} from "./types.js";

// --- Row shapes (snake_case, matching db/schema.sql) ---

interface AgentRow {
  agent_id: string;
  owner: string;
  payment_wallet: string | null;
  name: string | null;
  image: string | null;
  first_seen: string;
  synthetic: boolean;
}

/**
 * Factor as stored for the frontend's display convention: `value` is a 0–100
 * percentage and `contribution` is in score points (normalized × weight × 850),
 * matching what the Lovable UI renders. `value_raw` preserves the engine's raw
 * measurement so reads round-trip back to the canonical Factor.
 */
interface StoredFactor {
  key: Factor["key"];
  weight: number;
  normalized: number;
  bootstrapped: boolean;
  value: number; // 0–100
  contribution: number; // points (0–850 scale)
  value_raw: number; // engine's raw measured value
}

const POINTS_SCALE = 850;

function toStoredFactor(f: Factor): StoredFactor {
  return {
    key: f.key,
    weight: f.weight,
    normalized: f.normalized,
    bootstrapped: f.bootstrapped,
    value: Math.round(f.normalized * 100),
    contribution: Math.round(f.normalized * f.weight * POINTS_SCALE),
    value_raw: f.value,
  };
}

function fromStoredFactor(f: StoredFactor): Factor {
  return {
    key: f.key,
    value: f.value_raw ?? f.value,
    normalized: f.normalized,
    weight: f.weight,
    contribution: f.normalized * f.weight,
    bootstrapped: f.bootstrapped ?? false,
  };
}

interface ScoreRow {
  agent_id: string;
  score: number;
  band: Band;
  status: Status;
  limit_amount: number | null;
  limit_currency: string | null;
  limit_period: Period | null;
  attested: boolean;
  factors: StoredFactor[];
  updated_at: string;
}

interface SettlementRow {
  id: string;
  agent_id: string;
  tab_id: string | null;
  counterparty: string | null;
  amount: number;
  currency: string;
  status: SettlementStatus;
  on_time: boolean;
  occurred_at: string;
}

interface IdempotencyRow {
  key: string;
  request_hash: string;
  settlement_id: string;
}

// --- Pure row <-> record mappers (unit-tested) ---

export const toAgentRow = (a: AgentRecord): AgentRow => ({
  agent_id: a.agentId,
  owner: a.owner,
  payment_wallet: a.paymentWallet,
  name: a.name,
  image: a.image,
  first_seen: a.firstSeen,
  synthetic: a.synthetic,
});

export const fromAgentRow = (r: AgentRow): AgentRecord => ({
  agentId: r.agent_id,
  owner: r.owner,
  paymentWallet: r.payment_wallet,
  name: r.name,
  image: r.image,
  firstSeen: r.first_seen,
  synthetic: r.synthetic,
});

export const toScoreRow = (s: ScoreRecord): ScoreRow => ({
  agent_id: s.agentId,
  score: s.score,
  band: s.band,
  status: s.status,
  limit_amount: s.limit?.amount ?? null,
  limit_currency: s.limit?.currency ?? null,
  limit_period: s.limit?.period ?? null,
  attested: s.attested,
  factors: s.factors.map(toStoredFactor),
  updated_at: s.updatedAt,
});

export const fromScoreRow = (r: ScoreRow): ScoreRecord => {
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
    factors: (r.factors ?? []).map(fromStoredFactor),
    updatedAt: r.updated_at,
  };
};

export const toSettlementRow = (s: SettlementRecord): SettlementRow => ({
  id: s.id,
  agent_id: s.agentId,
  tab_id: s.tabId,
  counterparty: s.counterparty,
  amount: s.amount,
  currency: s.currency,
  status: s.status,
  on_time: s.onTime,
  occurred_at: s.occurredAt,
});

export const fromSettlementRow = (r: SettlementRow): SettlementRecord => ({
  id: r.id,
  agentId: r.agent_id,
  tabId: r.tab_id,
  counterparty: r.counterparty,
  amount: r.amount,
  currency: r.currency,
  status: r.status,
  onTime: r.on_time,
  occurredAt: r.occurred_at,
});

export interface SupabaseStoreOptions {
  url: string;
  serviceKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Supabase-backed Store via the PostgREST API (no SDK dependency). Apply
 * db/schema.sql to the project first. Uses the service-role key — server-side
 * only. Upserts via `Prefer: resolution=merge-duplicates`.
 */
export class SupabaseStore implements Store {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SupabaseStoreOptions) {
    this.base = `${opts.url.replace(/\/$/, "")}/rest/v1`;
    this.headers = {
      apikey: opts.serviceKey,
      Authorization: `Bearer ${opts.serviceKey}`,
      "content-type": "application/json",
    };
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { ...this.headers, ...(init.headers as Record<string, string>) },
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Supabase ${res.status} on ${path}: ${text}`);
      return (text ? JSON.parse(text) : null) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private upsert(table: string, row: unknown): Promise<unknown> {
    return this.req(`/${table}`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
  }

  async upsertAgent(agent: AgentRecord): Promise<void> {
    await this.upsert("agents", toAgentRow(agent));
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    const rows = await this.req<AgentRow[]>(`/agents?agent_id=eq.${enc(agentId)}&limit=1`);
    return rows[0] ? fromAgentRow(rows[0]) : null;
  }

  async upsertScore(score: ScoreRecord): Promise<void> {
    await this.upsert("scores", toScoreRow(score));
  }

  async getScore(agentId: string): Promise<ScoreRecord | null> {
    const rows = await this.req<ScoreRow[]>(`/scores?agent_id=eq.${enc(agentId)}&limit=1`);
    return rows[0] ? fromScoreRow(rows[0]) : null;
  }

  async listScores(params: ListScoresParams): Promise<Page<ScoreRecord>> {
    // Fetch candidate rows (status filtered server-side) then apply identical
    // sort/cursor semantics in-process so every backend agrees.
    const filter = params.status ? `&status=eq.${params.status}` : "";
    const rows = await this.req<ScoreRow[]>(`/scores?select=*${filter}&order=score.desc&limit=1000`);
    return sortAndPaginate(rows.map(fromScoreRow), params);
  }

  async insertSettlement(s: SettlementRecord): Promise<void> {
    await this.req(`/settlements`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(toSettlementRow(s)),
    });
  }

  async getSettlement(id: string): Promise<SettlementRecord | null> {
    const rows = await this.req<SettlementRow[]>(`/settlements?id=eq.${enc(id)}&limit=1`);
    return rows[0] ? fromSettlementRow(rows[0]) : null;
  }

  async listSettlementsByAgent(agentId: string, limit = 50): Promise<SettlementRecord[]> {
    const n = clampLimit(limit, 50);
    const rows = await this.req<SettlementRow[]>(
      `/settlements?agent_id=eq.${enc(agentId)}&order=occurred_at.desc&limit=${n}`,
    );
    return rows.map(fromSettlementRow);
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    const rows = await this.req<IdempotencyRow[]>(`/idempotency_keys?key=eq.${enc(key)}&limit=1`);
    const r = rows[0];
    return r ? { key: r.key, requestHash: r.request_hash, settlementId: r.settlement_id } : null;
  }

  async putIdempotency(rec: IdempotencyRecord): Promise<void> {
    await this.req(`/idempotency_keys`, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ key: rec.key, request_hash: rec.requestHash, settlement_id: rec.settlementId }),
    });
  }
}

function enc(v: string): string {
  return encodeURIComponent(v);
}
