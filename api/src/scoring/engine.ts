import type {
  Band,
  Factor,
  FactorKey,
  Limit,
  ScoreResult,
  ScoringInput,
  Status,
} from "./types.js";

// --- Tunable model constants (v0). Keep transparent and documented. ---

export const WEIGHTS: Record<FactorKey, number> = {
  on_time_rate: 0.3,
  volume: 0.25,
  account_age: 0.15,
  counterparty_diversity: 0.15,
  defaults: 0.15,
};

const SCORE_MIN = 300;
const SCORE_MAX = 850;

/** Targets at which a factor is considered "fully" strong (normalized = 1). */
const ACCOUNT_AGE_FULL_DAYS = 365;
const DIVERSITY_FULL_COUNT = 20;
/** Volume (major USDC) at which the volume factor saturates. */
const VOLUME_FULL_USDC = 100_000;
const USDC_DECIMALS = 1_000_000;

/** Bootstrapped (8004-only) factors are dampened — we trust observed ledger more. */
const BOOTSTRAP_CONFIDENCE = 0.7;

/** Limit sizing. */
const LIMIT_FLOOR_USDC = 50; // minimum ceiling for an eligible low-volume agent
const LIMIT_CEILING_USDC = 1_000_000;
const LIMIT_BAND_MULTIPLIER: Record<Band, number> = {
  poor: 0,
  fair: 0.25,
  good: 0.5,
  very_good: 0.75,
  excellent: 1.0,
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function bandFor(score: number): Band {
  if (score >= 800) return "excellent";
  if (score >= 740) return "very_good";
  if (score >= 670) return "good";
  if (score >= 580) return "fair";
  return "poor";
}

/** 8004 reputation collapsed into a single 0–1 proxy for bootstrapping. */
function reputationProxy(input: ScoringInput): number {
  const { nonRevokedShare, positiveValueShare, atomQualityScore, atomTrustTier } =
    input.reputation;
  const atomQuality = clamp01(atomQualityScore / 10_000);
  const atomTier = clamp01(atomTrustTier / 4);
  // Average the available signals; ATOM is often unrated (0) on devnet, so the
  // feedback-derived shares carry most of the weight in practice.
  return clamp01(
    0.4 * nonRevokedShare + 0.3 * positiveValueShare + 0.2 * atomQuality + 0.1 * atomTier,
  );
}

function computeFactors(input: ScoringInput): Factor[] {
  const { identity, ledger } = input;
  const hasLedger = ledger.settledCount > 0;
  const proxy = reputationProxy(input);

  // on_time_rate — observed share, or dampened reputation proxy when no ledger.
  const onTimeObserved = hasLedger ? ledger.onTimeCount / ledger.settledCount : 0;
  const onTime: Factor = makeFactor(
    "on_time_rate",
    hasLedger ? onTimeObserved : proxy,
    hasLedger ? onTimeObserved : proxy * BOOTSTRAP_CONFIDENCE,
    !hasLedger,
  );

  // volume — log-scaled settled value, or a weak activity proxy from feedback count.
  const volumeUsdc = ledger.totalVolume / USDC_DECIMALS;
  const volumeNormObserved =
    Math.log10(1 + volumeUsdc) / Math.log10(1 + VOLUME_FULL_USDC);
  const activityProxy = clamp01(input.reputation.totalFeedback / 50) * 0.5;
  const volume: Factor = makeFactor(
    "volume",
    hasLedger ? volumeUsdc : 0,
    hasLedger ? volumeNormObserved : activityProxy * BOOTSTRAP_CONFIDENCE,
    !hasLedger,
  );

  // account_age — 8004 identity age. Always observed.
  const age: Factor = makeFactor(
    "account_age",
    identity.accountAgeDays,
    identity.accountAgeDays / ACCOUNT_AGE_FULL_DAYS,
    false,
  );

  // counterparty_diversity — distinct counterparties (8004 + ledger). Observed.
  const diversity: Factor = makeFactor(
    "counterparty_diversity",
    identity.distinctCounterparties,
    identity.distinctCounterparties / DIVERSITY_FULL_COUNT,
    false,
  );

  // defaults — penalty. normalized = 1 (best) when none; steep decay per default.
  const defaultsCount = ledger.defaultedCount;
  const defaults: Factor = makeFactor(
    "defaults",
    defaultsCount,
    1 / (1 + defaultsCount),
    false,
  );

  return [onTime, volume, age, diversity, defaults];
}

function makeFactor(
  key: FactorKey,
  value: number,
  normalizedRaw: number,
  bootstrapped: boolean,
): Factor {
  const normalized = clamp01(normalizedRaw);
  const weight = WEIGHTS[key];
  return {
    key,
    value,
    normalized,
    weight,
    contribution: normalized * weight,
    bootstrapped,
  };
}

function statusFor(score: number, input: ScoringInput): Status {
  if (input.ledger.hasActiveDefault || input.ledger.defaultedCount > 0) {
    return "defaulted";
  }
  if (score >= 670) return "good_standing";
  return "on_watch";
}

function limitFor(score: number, band: Band, status: Status, input: ScoringInput): Limit | null {
  if (status === "defaulted") return null;
  if (score < 580) return null; // poor band is not eligible

  const multiplier = LIMIT_BAND_MULTIPLIER[band];
  const observedWeekly = input.ledger.typicalPeriodVolume / USDC_DECIMALS;
  const base = Math.max(observedWeekly, LIMIT_FLOOR_USDC);
  const amountUsdc = Math.min(base * multiplier || LIMIT_FLOOR_USDC, LIMIT_CEILING_USDC);

  return {
    amount: Math.round(amountUsdc * USDC_DECIMALS),
    currency: "USDC",
    period: "week",
  };
}

/** Pure, deterministic credit scoring. Same input → same output. */
export function computeScore(input: ScoringInput): ScoreResult {
  const factors = computeFactors(input);
  const weightedSum = factors.reduce((acc, f) => acc + f.contribution, 0);
  const score = Math.round(SCORE_MIN + clamp01(weightedSum) * (SCORE_MAX - SCORE_MIN));
  const band = bandFor(score);
  const status = statusFor(score, input);
  const limit = limitFor(score, band, status, input);

  return { agentId: input.agentId, score, band, status, limit, factors };
}
