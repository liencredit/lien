// The scoring engine is a pure, deterministic function: same input → same output.
// It is intentionally decoupled from 8004 GraphQL shapes — the reader/ledger layer
// produces a normalized `ScoringInput`, the engine maps it to a `ScoreResult`.

export type FactorKey =
  | "on_time_rate"
  | "volume"
  | "account_age"
  | "counterparty_diversity"
  | "defaults";

export type Band = "poor" | "fair" | "good" | "very_good" | "excellent";

export type Status = "good_standing" | "on_watch" | "defaulted";

export type Period = "day" | "week" | "month";

/** Signals imported from the agent's 8004 record. Used to bootstrap factors that
 * have no LIEN settlement history yet. */
export interface ReputationSignal {
  /** Total feedback count on the 8004 record. */
  totalFeedback: number;
  /** Share of feedback that is NOT revoked (0–1). */
  nonRevokedShare: number;
  /** Share of non-revoked feedback with a positive `value` (0–1). */
  positiveValueShare: number;
  /** ATOM quality score (0–10000). 0 when unrated. */
  atomQualityScore: number;
  /** ATOM trust tier (0–4 = Unrated…Platinum). */
  atomTrustTier: number;
}

/** Outcomes LIEN has directly observed via `POST /settlements`. */
export interface LedgerSignal {
  settledCount: number;
  onTimeCount: number;
  /** Count of obligations that ended in default within the window. */
  defaultedCount: number;
  /** Whether the agent currently has an open, unsettled default. */
  hasActiveDefault: boolean;
  /** Total settled value in the window, minor units (USDC, 6 decimals). */
  totalVolume: number;
  /** Typical settled value per period, minor units. */
  typicalPeriodVolume: number;
}

export interface ScoringInput {
  agentId: string;
  identity: {
    accountAgeDays: number;
    /** Distinct counterparties across 8004 feedback + LIEN ledger. */
    distinctCounterparties: number;
  };
  reputation: ReputationSignal;
  ledger: LedgerSignal;
}

export interface Factor {
  key: FactorKey;
  /** Raw measured value for the factor (human-meaningful, not normalized). */
  value: number;
  /** Normalized 0–1 strength of this factor. */
  normalized: number;
  /** Factor weight in the model (0–1). */
  weight: number;
  /** Weighted share this factor contributed to the final 0–1 sum. */
  contribution: number;
  /** Whether this factor was bootstrapped from 8004 (no LIEN ledger yet). */
  bootstrapped: boolean;
}

export interface Limit {
  amount: number;
  currency: string;
  period: Period;
}

export interface ScoreResult {
  agentId: string;
  score: number;
  band: Band;
  status: Status;
  limit: Limit | null;
  factors: Factor[];
}
