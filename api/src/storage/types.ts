import type { Band, Factor, Limit, Status } from "../scoring/types.js";

export type { Band, Factor, Limit, Period, Status } from "../scoring/types.js";

// Domain records mirror the API objects in ../../LIEN-docs.md and the Supabase
// tables in ../../db/schema.sql. The Store interface is backend-agnostic: today
// it's in-memory; a Supabase adapter slots in behind the same contract.

export interface AgentRecord {
  agentId: string;
  owner: string;
  paymentWallet: string | null;
  name: string | null;
  image: string | null;
  firstSeen: string; // RFC 3339
  /** True for seeded demo agents. Never present these as live metrics. */
  synthetic: boolean;
}

export interface ScoreRecord {
  agentId: string;
  score: number;
  band: Band;
  status: Status;
  limit: Limit | null;
  attested: boolean;
  factors: Factor[];
  updatedAt: string; // RFC 3339
}

export type SettlementStatus = "settled" | "late" | "defaulted";

export interface SettlementRecord {
  id: string;
  agentId: string;
  tabId: string | null;
  counterparty: string | null;
  amount: number; // minor units
  currency: string;
  status: SettlementStatus;
  onTime: boolean;
  occurredAt: string; // RFC 3339
}

export type RegistrySort = "score" | "volume" | "recent";

export interface ListScoresParams {
  sort?: RegistrySort;
  status?: Status;
  limit?: number; // 1–100
  startingAfter?: string; // cursor = agentId of last item
}

export interface Page<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** Idempotency bookkeeping for POST /settlements. */
export interface IdempotencyRecord {
  key: string;
  requestHash: string;
  settlementId: string;
}

export interface Store {
  // agents
  upsertAgent(agent: AgentRecord): Promise<void>;
  getAgent(agentId: string): Promise<AgentRecord | null>;

  // scores
  upsertScore(score: ScoreRecord): Promise<void>;
  getScore(agentId: string): Promise<ScoreRecord | null>;
  listScores(params: ListScoresParams): Promise<Page<ScoreRecord>>;

  // settlements
  insertSettlement(s: SettlementRecord): Promise<void>;
  getSettlement(id: string): Promise<SettlementRecord | null>;
  listSettlementsByAgent(agentId: string, limit?: number): Promise<SettlementRecord[]>;

  // idempotency
  getIdempotency(key: string): Promise<IdempotencyRecord | null>;
  putIdempotency(rec: IdempotencyRecord): Promise<void>;

  // wallet ↔ 8004 aliases (signed linking)
  /** Link a payment wallet to a canonical (8004) agent id. */
  putAlias(wallet: string, agentId: string): Promise<void>;
  /** Resolve a wallet to its canonical agent id, or null if unlinked. */
  getAlias(wallet: string): Promise<string | null>;
  /** All wallets linked to a canonical agent id. */
  listAliases(agentId: string): Promise<string[]>;
}
