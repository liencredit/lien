import type { RawAgent } from "../registry/types.js";
import type { ScoreRecord, SettlementRecord } from "../storage/types.js";

// Map internal records to the public API objects defined in ../../LIEN-docs.md
// (snake_case, tagged with `object`).

export function serializeCreditScore(s: ScoreRecord) {
  return {
    object: "credit_score" as const,
    agent_id: s.agentId,
    score: s.score,
    band: s.band,
    status: s.status,
    limit: s.limit,
    attested: s.attested,
    updated_at: s.updatedAt,
  };
}

export function serializeFactor(f: ScoreRecord["factors"][number]) {
  return {
    key: f.key,
    value: f.value,
    weight: f.weight,
    contribution: f.contribution,
    // Additive (non-spec) fields — clients ignore unknown fields per Versioning.
    normalized: f.normalized,
    bootstrapped: f.bootstrapped,
  };
}

export function serializeSettlement(s: SettlementRecord) {
  return {
    object: "settlement" as const,
    id: s.id,
    agent_id: s.agentId,
    tab_id: s.tabId,
    counterparty: s.counterparty,
    amount: s.amount,
    currency: s.currency,
    status: s.status,
    occurred_at: s.occurredAt,
  };
}

export interface ReportIdentity {
  name: string | null;
  image: string | null;
  verified_8004: boolean;
}

export function serializeReport(
  score: ScoreRecord,
  identity: ReportIdentity,
  settlements: SettlementRecord[],
) {
  return {
    ...serializeCreditScore(score),
    object: "report" as const,
    identity,
    factors: score.factors.map(serializeFactor),
    recent_settlements: settlements.map(serializeSettlement),
  };
}

export function serializeList<T>(data: T[], hasMore: boolean, nextCursor: string | null) {
  return { object: "list" as const, data, has_more: hasMore, next_cursor: nextCursor };
}

/** Identity block for a report, from the resolved 8004 agent (or fallback). */
export function identityFromAgent(agent: RawAgent | null, name: string | null, image: string | null): ReportIdentity {
  return {
    name: agent?.registrationFile?.name ?? name,
    image: agent?.registrationFile?.image ?? image,
    verified_8004: agent !== null,
  };
}
