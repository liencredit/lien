import { clampLimit, sortAndPaginate } from "./query.js";
import type {
  AgentRecord,
  IdempotencyRecord,
  ListScoresParams,
  Page,
  ScoreRecord,
  SettlementRecord,
  Store,
} from "./types.js";

/**
 * In-memory Store. Sufficient for dev, tests, and the seeded demo. Swap for a
 * Supabase-backed Store (same interface) once credentials are wired — see
 * ../../db/schema.sql.
 */
export class MemoryStore implements Store {
  private agents = new Map<string, AgentRecord>();
  private scores = new Map<string, ScoreRecord>();
  private settlements = new Map<string, SettlementRecord>();
  private settlementsByAgent = new Map<string, string[]>();
  private idempotency = new Map<string, IdempotencyRecord>();
  private aliases = new Map<string, string>(); // wallet -> canonical agentId

  async upsertAgent(agent: AgentRecord): Promise<void> {
    this.agents.set(agent.agentId, agent);
  }

  async getAgent(agentId: string): Promise<AgentRecord | null> {
    return this.agents.get(agentId) ?? null;
  }

  async upsertScore(score: ScoreRecord): Promise<void> {
    this.scores.set(score.agentId, score);
  }

  async getScore(agentId: string): Promise<ScoreRecord | null> {
    return this.scores.get(agentId) ?? null;
  }

  async listScores(params: ListScoresParams): Promise<Page<ScoreRecord>> {
    return sortAndPaginate([...this.scores.values()], params);
  }

  async insertSettlement(s: SettlementRecord): Promise<void> {
    this.settlements.set(s.id, s);
    const list = this.settlementsByAgent.get(s.agentId) ?? [];
    list.push(s.id);
    this.settlementsByAgent.set(s.agentId, list);
  }

  async getSettlement(id: string): Promise<SettlementRecord | null> {
    return this.settlements.get(id) ?? null;
  }

  async listSettlementsByAgent(agentId: string, limit = 50): Promise<SettlementRecord[]> {
    const ids = this.settlementsByAgent.get(agentId) ?? [];
    const rows = ids
      .map((id) => this.settlements.get(id))
      .filter((r): r is SettlementRecord => r !== undefined)
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    return rows.slice(0, clampLimit(limit));
  }

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    return this.idempotency.get(key) ?? null;
  }

  async putIdempotency(rec: IdempotencyRecord): Promise<void> {
    this.idempotency.set(rec.key, rec);
  }

  async putAlias(wallet: string, agentId: string): Promise<void> {
    this.aliases.set(wallet, agentId);
  }

  async getAlias(wallet: string): Promise<string | null> {
    return this.aliases.get(wallet) ?? null;
  }

  async listAliases(agentId: string): Promise<string[]> {
    return [...this.aliases.entries()].filter(([, a]) => a === agentId).map(([w]) => w);
  }
}
