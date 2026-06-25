import { computeScore } from "../scoring/engine.js";
import type { LedgerSignal, ScoringInput } from "../scoring/types.js";
import type {
  AgentRecord,
  ScoreRecord,
  SettlementRecord,
  SettlementStatus,
  Store,
} from "../storage/types.js";

const USDC = 1_000_000;
const DAY = 86_400_000;

// Deterministic synthetic agents spanning the band/status spectrum so the
// registry and profile pages look alive for the demo. These are NOT real
// on-chain agents — every record is flagged `synthetic: true`. Per LIEN_CONTEXT
// §11, never present these as real live metrics in production copy.

interface SeedProfile {
  id: string;
  name: string;
  owner: string;
  accountAgeDays: number;
  distinctCounterparties: number;
  nonRevokedShare: number;
  positiveValueShare: number;
  atomQualityScore: number;
  atomTrustTier: number;
  ledger: Partial<LedgerSignal>;
  /** How many recent settlement rows to fabricate for the profile page. */
  recentSettlements: number;
}

const PROFILES: SeedProfile[] = [
  {
    id: "agent:sol:7xKq9b9c4Atlas",
    name: "Atlas Indexing",
    owner: "AtLs1ownerPubkey1111111111111111111111111",
    accountAgeDays: 420,
    distinctCounterparties: 28,
    nonRevokedShare: 0.98,
    positiveValueShare: 0.95,
    atomQualityScore: 9200,
    atomTrustTier: 4,
    ledger: { settledCount: 120, onTimeCount: 119, totalVolume: 480_000 * USDC, typicalPeriodVolume: 9_000 * USDC },
    recentSettlements: 6,
  },
  {
    id: "agent:sol:4kP2meridianFx",
    name: "Meridian FX Router",
    owner: "Mrd1ownerPubkey22222222222222222222222222",
    accountAgeDays: 300,
    distinctCounterparties: 19,
    nonRevokedShare: 0.94,
    positiveValueShare: 0.9,
    atomQualityScore: 7800,
    atomTrustTier: 3,
    ledger: { settledCount: 60, onTimeCount: 57, totalVolume: 90_000 * USDC, typicalPeriodVolume: 3_000 * USDC },
    recentSettlements: 5,
  },
  {
    id: "agent:sol:9wRtbeaconAI",
    name: "Beacon Research",
    owner: "Bcn1ownerPubkey33333333333333333333333333",
    accountAgeDays: 210,
    distinctCounterparties: 12,
    nonRevokedShare: 0.9,
    positiveValueShare: 0.82,
    atomQualityScore: 6400,
    atomTrustTier: 3,
    ledger: { settledCount: 30, onTimeCount: 27, totalVolume: 24_000 * USDC, typicalPeriodVolume: 1_200 * USDC },
    recentSettlements: 4,
  },
  {
    id: "agent:sol:2hJ5corvusOps",
    name: "Corvus Ops",
    owner: "Crv1ownerPubkey44444444444444444444444444",
    accountAgeDays: 140,
    distinctCounterparties: 8,
    nonRevokedShare: 0.85,
    positiveValueShare: 0.7,
    atomQualityScore: 4200,
    atomTrustTier: 2,
    ledger: { settledCount: 14, onTimeCount: 11, totalVolume: 6_000 * USDC, typicalPeriodVolume: 600 * USDC },
    recentSettlements: 4,
  },
  {
    id: "agent:sol:6yTnlumenBot",
    name: "Lumen Synth",
    owner: "Lmn1ownerPubkey55555555555555555555555555",
    accountAgeDays: 75,
    distinctCounterparties: 5,
    nonRevokedShare: 0.78,
    positiveValueShare: 0.6,
    atomQualityScore: 2600,
    atomTrustTier: 1,
    ledger: { settledCount: 6, onTimeCount: 4, totalVolume: 1_200 * USDC, typicalPeriodVolume: 200 * USDC },
    recentSettlements: 3,
  },
  {
    id: "agent:sol:3zXqnovaSeed",
    name: "Nova (new)",
    owner: "Nva1ownerPubkey66666666666666666666666666",
    accountAgeDays: 12,
    distinctCounterparties: 2,
    nonRevokedShare: 0.66,
    positiveValueShare: 0.5,
    atomQualityScore: 0,
    atomTrustTier: 0,
    ledger: {}, // no settlements yet → bootstrap path
    recentSettlements: 0,
  },
  {
    id: "agent:sol:8pLkharborDef",
    name: "Harbor Default",
    owner: "Hbr1ownerPubkey77777777777777777777777777",
    accountAgeDays: 180,
    distinctCounterparties: 9,
    nonRevokedShare: 0.7,
    positiveValueShare: 0.55,
    atomQualityScore: 3000,
    atomTrustTier: 1,
    ledger: { settledCount: 20, onTimeCount: 12, defaultedCount: 2, hasActiveDefault: true, totalVolume: 8_000 * USDC, typicalPeriodVolume: 500 * USDC },
    recentSettlements: 5,
  },
];

function isoDaysAgo(days: number, now: number): string {
  return new Date(now - days * DAY).toISOString();
}

function buildScoringInput(p: SeedProfile): ScoringInput {
  return {
    agentId: p.id,
    identity: {
      accountAgeDays: p.accountAgeDays,
      distinctCounterparties: p.distinctCounterparties,
    },
    reputation: {
      totalFeedback: Math.round(p.distinctCounterparties * 2.5),
      nonRevokedShare: p.nonRevokedShare,
      positiveValueShare: p.positiveValueShare,
      atomQualityScore: p.atomQualityScore,
      atomTrustTier: p.atomTrustTier,
    },
    ledger: {
      settledCount: 0,
      onTimeCount: 0,
      defaultedCount: 0,
      hasActiveDefault: false,
      totalVolume: 0,
      typicalPeriodVolume: 0,
      ...p.ledger,
    },
  };
}

function buildSettlements(p: SeedProfile, now: number): SettlementRecord[] {
  const rows: SettlementRecord[] = [];
  const perPeriod = p.ledger.typicalPeriodVolume ?? 0;
  for (let i = 0; i < p.recentSettlements; i++) {
    const isDefault = p.ledger.hasActiveDefault && i === 0;
    const isLate = !isDefault && i === 1 && (p.ledger.onTimeCount ?? 0) < (p.ledger.settledCount ?? 0);
    const status: SettlementStatus = isDefault ? "defaulted" : isLate ? "late" : "settled";
    rows.push({
      id: `stl_seed_${p.id.split(":").pop()}_${i}`,
      agentId: p.id,
      tabId: `tab_seed_${i}`,
      counterparty: `cp_${(i + 3).toString(36)}${p.owner.slice(0, 4)}`,
      amount: Math.max(USDC, Math.round(perPeriod * (0.6 + 0.1 * i))),
      currency: "USDC",
      status,
      onTime: status === "settled",
      occurredAt: isoDaysAgo(i * 7 + 1, now),
    });
  }
  return rows;
}

export interface SeedResult {
  agents: number;
  settlements: number;
}

/** Load deterministic synthetic data into the store. Idempotent. */
export async function seedStore(store: Store, now = Date.now()): Promise<SeedResult> {
  let settlementCount = 0;

  for (const p of PROFILES) {
    const agent: AgentRecord = {
      agentId: p.id,
      owner: p.owner,
      paymentWallet: p.owner,
      name: p.name,
      image: null,
      firstSeen: isoDaysAgo(p.accountAgeDays, now),
      synthetic: true,
    };
    await store.upsertAgent(agent);

    const result = computeScore(buildScoringInput(p));
    const score: ScoreRecord = {
      agentId: p.id,
      score: result.score,
      band: result.band,
      status: result.status,
      limit: result.limit,
      attested: false,
      factors: result.factors,
      updatedAt: isoDaysAgo(0, now),
    };
    await store.upsertScore(score);

    for (const s of buildSettlements(p, now)) {
      await store.insertSettlement(s);
      settlementCount++;
    }
  }

  return { agents: PROFILES.length, settlements: settlementCount };
}
