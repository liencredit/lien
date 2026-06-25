import type { RawAgent, RawFeedback } from "../registry/types.js";
import type { LedgerSignal, ScoringInput } from "./types.js";

const EMPTY_LEDGER: LedgerSignal = {
  settledCount: 0,
  onTimeCount: 0,
  defaultedCount: 0,
  hasActiveDefault: false,
  totalVolume: 0,
  typicalPeriodVolume: 0,
};

export interface DeriveOptions {
  /** LIEN's observed settlement signal. Omit/empty → bootstrap from 8004 only. */
  ledger?: Partial<LedgerSignal>;
  /** Counterparties seen in the ledger, to union with 8004 feedback clients. */
  ledgerCounterparties?: string[];
  /** Clock override for deterministic tests (ms since epoch). */
  nowMs?: number;
}

/**
 * Map a raw 8004 agent + its feedback into the normalized `ScoringInput` the
 * engine consumes. The ledger half is supplied separately (from Supabase, later).
 */
export function deriveScoringInput(
  agent: RawAgent,
  feedback: RawFeedback[],
  opts: DeriveOptions = {},
): ScoringInput {
  const nowMs = opts.nowMs ?? Date.now();
  const ledger: LedgerSignal = { ...EMPTY_LEDGER, ...opts.ledger };

  const active = feedback.filter((f) => !f.isRevoked);
  const total = feedback.length;
  const nonRevokedShare = total > 0 ? active.length / total : 0;
  const positiveValueShare =
    active.length > 0
      ? active.filter((f) => Number(f.value) > 0).length / active.length
      : 0;

  const counterparties = new Set<string>();
  for (const f of active) counterparties.add(f.clientAddress);
  for (const c of opts.ledgerCounterparties ?? []) counterparties.add(c);

  const accountAgeDays = Math.max(
    0,
    Math.round((nowMs - Number(agent.createdAt) * 1000) / 86_400_000),
  );

  return {
    agentId: agent.id,
    identity: {
      accountAgeDays,
      distinctCounterparties: counterparties.size,
    },
    reputation: {
      totalFeedback: Number(agent.totalFeedback) || total,
      nonRevokedShare,
      positiveValueShare,
      atomQualityScore: agent.solana?.qualityScore ?? 0,
      atomTrustTier: agent.solana?.trustTier ?? 0,
    },
    ledger,
  };
}

/**
 * Build a `ScoringInput` for an agent that has NO 8004 identity — scored purely
 * from its observed LIEN settlement ledger (e.g. an x402 payment wallet). There
 * are no 8004 reputation signals, so bootstrap factors stay zero; the score is
 * driven entirely by volume / on-time / diversity / defaults / age the network
 * has actually reported. Identity age is anchored to the earliest settlement.
 */
export function deriveLedgerOnlyInput(
  agentId: string,
  ledger: LedgerSignal,
  counterparties: string[],
  firstSeenMs: number,
  nowMs = Date.now(),
): ScoringInput {
  const accountAgeDays = Math.max(0, Math.round((nowMs - firstSeenMs) / 86_400_000));
  return {
    agentId,
    identity: {
      accountAgeDays,
      distinctCounterparties: new Set(counterparties).size,
    },
    reputation: {
      totalFeedback: 0,
      nonRevokedShare: 0,
      positiveValueShare: 0,
      atomQualityScore: 0,
      atomTrustTier: 0,
    },
    ledger,
  };
}
