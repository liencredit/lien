import type { RegistryReader } from "../registry/reader.js";
import { deriveLedgerOnlyInput, deriveScoringInput } from "../scoring/derive.js";
import { computeScore } from "../scoring/engine.js";
import type { LedgerSignal } from "../scoring/types.js";
import type {
  AgentRecord,
  ScoreRecord,
  SettlementRecord,
  Store,
} from "../storage/types.js";
import { diffScoreEvents, type WebhookDispatcher } from "./webhooks.js";

const DAY = 86_400_000;
const WINDOW_DAYS = 90;
const PERIOD_DAYS = 7;

/** Aggregate a settlement ledger into the engine's LedgerSignal (90-day window). */
export function ledgerFromSettlements(
  settlements: SettlementRecord[],
  now = Date.now(),
): { signal: LedgerSignal; counterparties: string[] } {
  const cutoff = now - WINDOW_DAYS * DAY;
  const inWindow = settlements.filter((s) => Date.parse(s.occurredAt) >= cutoff);

  let onTimeCount = 0;
  let defaultedCount = 0;
  let totalVolume = 0;
  let hasActiveDefault = false;
  const counterparties = new Set<string>();

  for (const s of inWindow) {
    if (s.counterparty) counterparties.add(s.counterparty);
    if (s.status === "defaulted") {
      defaultedCount++;
      hasActiveDefault = true;
    } else {
      totalVolume += s.amount;
      if (s.onTime) onTimeCount++;
    }
  }

  const settledCount = inWindow.filter((s) => s.status !== "defaulted").length;
  const periods = Math.max(1, WINDOW_DAYS / PERIOD_DAYS);

  return {
    signal: {
      settledCount,
      onTimeCount,
      defaultedCount,
      hasActiveDefault,
      totalVolume,
      typicalPeriodVolume: Math.round(totalVolume / periods),
    },
    counterparties: [...counterparties],
  };
}

/**
 * Ties the layers together: read 8004 → fold in the LIEN ledger → score → persist.
 * This is what the REST API and batch jobs call to (re)compute a score.
 */
export class ScoringService {
  constructor(
    private readonly reader: RegistryReader,
    private readonly store: Store,
    private readonly webhooks?: WebhookDispatcher,
  ) {}

  /**
   * Recompute and persist a score for an agent. If the agent has an 8004
   * identity we blend reputation with the ledger; otherwise we fall back to a
   * ledger-only score (x402 / payment-wallet agents). Returns null only when we
   * have neither an 8004 record nor any reported settlements — i.e. an agent we
   * have never seen, which has no credit file to score.
   */
  async refreshAgent(agentId: string, now = Date.now()): Promise<ScoreRecord | null> {
    const agent = await this.reader.resolveAgent(agentId);
    if (!agent) return this.refreshLedgerOnly(agentId, now);

    const feedback = await this.reader.getFeedback(agent.id, { first: 100, includeRevoked: true });
    const settlements = await this.store.listSettlementsByAgent(agent.id, 100);
    const { signal, counterparties } = ledgerFromSettlements(settlements, now);

    const input = deriveScoringInput(agent, feedback, {
      ledger: signal,
      ledgerCounterparties: counterparties,
      nowMs: now,
    });
    const result = computeScore(input);

    const agentRecord: AgentRecord = {
      agentId: agent.id,
      owner: agent.owner,
      paymentWallet: agent.owner,
      name: agent.registrationFile?.name ?? null,
      image: agent.registrationFile?.image ?? null,
      firstSeen: new Date(Number(agent.createdAt) * 1000).toISOString(),
      synthetic: false,
    };
    await this.store.upsertAgent(agentRecord);

    const existing = await this.store.getScore(agent.id);
    const scoreRecord: ScoreRecord = {
      agentId: agent.id,
      score: result.score,
      band: result.band,
      status: result.status,
      limit: result.limit,
      attested: existing?.attested ?? false,
      factors: result.factors,
      updatedAt: new Date(now).toISOString(),
    };
    await this.store.upsertScore(scoreRecord);
    this.webhooks?.emitAll(diffScoreEvents(existing, scoreRecord));

    return scoreRecord;
  }

  /**
   * Score an agent that has no 8004 identity, purely from its reported
   * settlement ledger (e.g. an x402 payment wallet). Returns null when there is
   * no ledger to score. Seeded synthetic agents are left untouched so a
   * settlement webhook never clobbers their demo score.
   */
  private async refreshLedgerOnly(agentId: string, now: number): Promise<ScoreRecord | null> {
    const existingAgent = await this.store.getAgent(agentId);
    if (existingAgent?.synthetic) return this.store.getScore(agentId);

    const settlements = await this.store.listSettlementsByAgent(agentId, 100);
    if (settlements.length === 0) return null;

    const { signal, counterparties } = ledgerFromSettlements(settlements, now);
    const firstSeenMs = Math.min(...settlements.map((s) => Date.parse(s.occurredAt)));
    const input = deriveLedgerOnlyInput(agentId, signal, counterparties, firstSeenMs, now);
    const result = computeScore(input);

    const agentRecord: AgentRecord = {
      agentId,
      owner: existingAgent?.owner ?? agentId,
      paymentWallet: existingAgent?.paymentWallet ?? agentId,
      name: existingAgent?.name ?? null,
      image: existingAgent?.image ?? null,
      firstSeen: existingAgent?.firstSeen ?? new Date(firstSeenMs).toISOString(),
      synthetic: false,
    };
    await this.store.upsertAgent(agentRecord);

    const existing = await this.store.getScore(agentId);
    const scoreRecord: ScoreRecord = {
      agentId,
      score: result.score,
      band: result.band,
      status: result.status,
      limit: result.limit,
      attested: existing?.attested ?? false,
      factors: result.factors,
      updatedAt: new Date(now).toISOString(),
    };
    await this.store.upsertScore(scoreRecord);
    this.webhooks?.emitAll(diffScoreEvents(existing, scoreRecord));

    return scoreRecord;
  }
}
