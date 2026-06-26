import assert from "node:assert/strict";
import { test } from "node:test";
import { seedStore } from "../seed/data.js";
import { ledgerFromSettlements } from "../service/scoring-service.js";
import { MemoryStore } from "./memory.js";
import type { SettlementRecord } from "./types.js";

const FIXED_NOW = Date.parse("2026-06-23T00:00:00Z");

test("seed loads synthetic agents and scores", async () => {
  const store = new MemoryStore();
  const result = await seedStore(store, FIXED_NOW);
  assert.ok(result.agents >= 7);

  const page = await store.listScores({ limit: 100 });
  assert.equal(page.data.length, result.agents);
  for (const s of page.data) {
    assert.ok(s.score >= 300 && s.score <= 850);
    const agent = await store.getAgent(s.agentId);
    assert.equal(agent?.synthetic, true);
  }
});

test("seed is deterministic", async () => {
  const a = new MemoryStore();
  const b = new MemoryStore();
  await seedStore(a, FIXED_NOW);
  await seedStore(b, FIXED_NOW);
  const pa = await a.listScores({ limit: 100 });
  const pb = await b.listScores({ limit: 100 });
  assert.deepEqual(pa.data, pb.data);
});

test("registry sorts by score desc by default", async () => {
  const store = new MemoryStore();
  await seedStore(store, FIXED_NOW);
  const page = await store.listScores({ sort: "score", limit: 100 });
  for (let i = 1; i < page.data.length; i++) {
    assert.ok(page.data[i - 1]!.score >= page.data[i]!.score);
  }
});

test("registry status filter works", async () => {
  const store = new MemoryStore();
  await seedStore(store, FIXED_NOW);
  const defaulted = await store.listScores({ status: "defaulted", limit: 100 });
  assert.ok(defaulted.data.length >= 1);
  for (const s of defaulted.data) assert.equal(s.status, "defaulted");
});

test("excludeSynthetic hides seeded demo agents from the registry", async () => {
  const store = new MemoryStore();
  await seedStore(store, FIXED_NOW);

  // A real (non-synthetic) agent + score.
  await store.upsertAgent({
    agentId: "agent:real",
    owner: "owner",
    paymentWallet: "wallet",
    name: "Real Agent",
    image: null,
    firstSeen: new Date(FIXED_NOW).toISOString(),
    synthetic: false,
  });
  await store.upsertScore({
    agentId: "agent:real",
    score: 506,
    band: "poor",
    status: "good_standing",
    limit: null,
    attested: false,
    factors: [],
    updatedAt: new Date(FIXED_NOW).toISOString(),
  });

  const withSynthetic = await store.listScores({ limit: 100 });
  const realOnly = await store.listScores({ limit: 100, excludeSynthetic: true });

  assert.ok(withSynthetic.data.length > realOnly.data.length);
  assert.equal(realOnly.data.length, 1);
  assert.equal(realOnly.data[0]!.agentId, "agent:real");
});

test("cursor pagination walks the whole list without gaps or repeats", async () => {
  const store = new MemoryStore();
  await seedStore(store, FIXED_NOW);

  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await store.listScores({ limit: 2, startingAfter: cursor ?? undefined });
    for (const s of page.data) {
      assert.ok(!seen.has(s.agentId), `duplicate ${s.agentId}`);
      seen.add(s.agentId);
    }
    cursor = page.nextCursor;
    pages++;
    assert.ok(pages < 100, "pagination did not terminate");
  } while (cursor);

  const all = await store.listScores({ limit: 100 });
  assert.equal(seen.size, all.data.length);
});

test("ledgerFromSettlements aggregates within the 90-day window", () => {
  const now = FIXED_NOW;
  const rows: SettlementRecord[] = [
    mk("a", "settled", true, 1000, 5, now),
    mk("b", "settled", true, 2000, 10, now),
    mk("c", "late", false, 1500, 20, now),
    mk("d", "defaulted", false, 9999, 30, now),
    mk("old", "settled", true, 5000, 200, now), // outside 90d window
  ];
  const { signal, counterparties } = ledgerFromSettlements(rows, now);

  assert.equal(signal.defaultedCount, 1);
  assert.equal(signal.hasActiveDefault, true);
  assert.equal(signal.settledCount, 3); // a, b, c (not the default, not the old one)
  assert.equal(signal.onTimeCount, 2); // a, b
  assert.equal(signal.totalVolume, 1000 + 2000 + 1500); // excludes default + old
  assert.equal(counterparties.length, 4);
});

function mk(
  cp: string,
  status: SettlementRecord["status"],
  onTime: boolean,
  amount: number,
  daysAgo: number,
  now: number,
): SettlementRecord {
  return {
    id: `s_${cp}`,
    agentId: "agent:test",
    tabId: null,
    counterparty: cp,
    amount,
    currency: "USDC",
    status,
    onTime,
    occurredAt: new Date(now - daysAgo * 86_400_000).toISOString(),
  };
}
