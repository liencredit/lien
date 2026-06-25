import assert from "node:assert/strict";
import { test } from "node:test";
import { computeScore, WEIGHTS } from "./engine.js";
import type { LedgerSignal, ReputationSignal, ScoringInput } from "./types.js";

const USDC = 1_000_000;

function input(overrides: {
  identity?: Partial<ScoringInput["identity"]>;
  reputation?: Partial<ReputationSignal>;
  ledger?: Partial<LedgerSignal>;
}): ScoringInput {
  return {
    agentId: "agent:sol:test",
    identity: {
      accountAgeDays: 0,
      distinctCounterparties: 0,
      ...overrides.identity,
    },
    reputation: {
      totalFeedback: 0,
      nonRevokedShare: 0,
      positiveValueShare: 0,
      atomQualityScore: 0,
      atomTrustTier: 0,
      ...overrides.reputation,
    },
    ledger: {
      settledCount: 0,
      onTimeCount: 0,
      defaultedCount: 0,
      hasActiveDefault: false,
      totalVolume: 0,
      typicalPeriodVolume: 0,
      ...overrides.ledger,
    },
  };
}

test("weights sum to 1", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `weights sum = ${sum}`);
});

test("is deterministic: same input -> same output", () => {
  const i = input({
    identity: { accountAgeDays: 200, distinctCounterparties: 10 },
    ledger: { settledCount: 10, onTimeCount: 9, totalVolume: 5_000 * USDC, typicalPeriodVolume: 500 * USDC },
  });
  assert.deepEqual(computeScore(i), computeScore(i));
});

test("score is always within 300..850", () => {
  const empty = computeScore(input({}));
  assert.ok(empty.score >= 300 && empty.score <= 850);

  const maxed = computeScore(
    input({
      identity: { accountAgeDays: 10_000, distinctCounterparties: 1000 },
      reputation: { totalFeedback: 1000, nonRevokedShare: 1, positiveValueShare: 1, atomQualityScore: 10_000, atomTrustTier: 4 },
      ledger: { settledCount: 100, onTimeCount: 100, totalVolume: 10_000_000 * USDC, typicalPeriodVolume: 100_000 * USDC },
    }),
  );
  assert.ok(maxed.score >= 300 && maxed.score <= 850);
});

test("an empty/new agent lands in poor band with no limit", () => {
  const r = computeScore(input({}));
  assert.equal(r.band, "poor");
  assert.equal(r.limit, null);
  assert.equal(r.status, "on_watch");
});

test("a strong, well-settled agent reaches good_standing with a limit", () => {
  const r = computeScore(
    input({
      identity: { accountAgeDays: 365, distinctCounterparties: 20 },
      reputation: { totalFeedback: 80, nonRevokedShare: 1, positiveValueShare: 1, atomQualityScore: 9000, atomTrustTier: 4 },
      ledger: { settledCount: 50, onTimeCount: 50, totalVolume: 100_000 * USDC, typicalPeriodVolume: 2_000 * USDC },
    }),
  );
  assert.ok(r.score >= 670, `score=${r.score}`);
  assert.equal(r.status, "good_standing");
  assert.ok(r.limit && r.limit.amount > 0);
  assert.equal(r.limit?.currency, "USDC");
});

test("an active default forces defaulted status and null limit", () => {
  const r = computeScore(
    input({
      identity: { accountAgeDays: 365, distinctCounterparties: 20 },
      ledger: { settledCount: 50, onTimeCount: 50, defaultedCount: 1, hasActiveDefault: true, totalVolume: 100_000 * USDC, typicalPeriodVolume: 2_000 * USDC },
    }),
  );
  assert.equal(r.status, "defaulted");
  assert.equal(r.limit, null);
});

test("defaults penalty lowers the score monotonically", () => {
  const base = {
    identity: { accountAgeDays: 365, distinctCounterparties: 20 },
    ledger: { settledCount: 50, onTimeCount: 50, totalVolume: 100_000 * USDC, typicalPeriodVolume: 2_000 * USDC },
  };
  const none = computeScore(input({ ...base, ledger: { ...base.ledger, defaultedCount: 0 } })).score;
  const one = computeScore(input({ ...base, ledger: { ...base.ledger, defaultedCount: 1 } })).score;
  const three = computeScore(input({ ...base, ledger: { ...base.ledger, defaultedCount: 3 } })).score;
  assert.ok(none > one, `none=${none} one=${one}`);
  assert.ok(one > three, `one=${one} three=${three}`);
});

test("bootstrap: ledgerless agent is scored from 8004 reputation, factors flagged", () => {
  const r = computeScore(
    input({
      identity: { accountAgeDays: 300, distinctCounterparties: 12 },
      reputation: { totalFeedback: 40, nonRevokedShare: 0.9, positiveValueShare: 0.8, atomQualityScore: 6000, atomTrustTier: 3 },
    }),
  );
  const onTime = r.factors.find((f) => f.key === "on_time_rate");
  const volume = r.factors.find((f) => f.key === "volume");
  assert.equal(onTime?.bootstrapped, true);
  assert.equal(volume?.bootstrapped, true);
  // Account age / diversity are always observed, never bootstrapped.
  assert.equal(r.factors.find((f) => f.key === "account_age")?.bootstrapped, false);
});

test("observed ledger beats bootstrap: factors not flagged once settled", () => {
  const r = computeScore(
    input({
      identity: { accountAgeDays: 300, distinctCounterparties: 12 },
      reputation: { totalFeedback: 40, nonRevokedShare: 0.9, positiveValueShare: 0.8 },
      ledger: { settledCount: 5, onTimeCount: 5, totalVolume: 1_000 * USDC, typicalPeriodVolume: 200 * USDC },
    }),
  );
  assert.equal(r.factors.find((f) => f.key === "on_time_rate")?.bootstrapped, false);
  assert.equal(r.factors.find((f) => f.key === "volume")?.bootstrapped, false);
});

test("contributions sum maps back to the score", () => {
  const r = computeScore(
    input({
      identity: { accountAgeDays: 365, distinctCounterparties: 20 },
      ledger: { settledCount: 10, onTimeCount: 8, totalVolume: 10_000 * USDC, typicalPeriodVolume: 1_000 * USDC },
    }),
  );
  const sum = r.factors.reduce((acc, f) => acc + f.contribution, 0);
  const expected = Math.round(300 + Math.min(1, sum) * 550);
  assert.equal(r.score, expected);
});
