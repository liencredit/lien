import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fromAgentRow,
  fromScoreRow,
  fromSettlementRow,
  SupabaseStore,
  toAgentRow,
  toScoreRow,
  toSettlementRow,
} from "./supabase.js";
import type { AgentRecord, ScoreRecord, SettlementRecord } from "./types.js";

const agent: AgentRecord = {
  agentId: "agent:sol:x",
  owner: "owner1",
  paymentWallet: "wallet1",
  name: "Test",
  image: null,
  firstSeen: "2026-01-01T00:00:00Z",
  synthetic: true,
};

const score: ScoreRecord = {
  agentId: "agent:sol:x",
  score: 742,
  band: "very_good",
  status: "good_standing",
  limit: { amount: 5_000_000, currency: "USDC", period: "week" },
  attested: true,
  factors: [{ key: "on_time_rate", value: 1, normalized: 1, weight: 0.3, contribution: 0.3, bootstrapped: false }],
  updatedAt: "2026-06-23T00:00:00Z",
};

const settlement: SettlementRecord = {
  id: "stl_1",
  agentId: "agent:sol:x",
  tabId: "tab_1",
  counterparty: "cp1",
  amount: 1_000_000,
  currency: "USDC",
  status: "settled",
  onTime: true,
  occurredAt: "2026-06-20T00:00:00Z",
};

test("agent row mapping round-trips", () => {
  assert.deepEqual(fromAgentRow(toAgentRow(agent)), agent);
});

test("score row mapping round-trips (with limit)", () => {
  assert.deepEqual(fromScoreRow(toScoreRow(score)), score);
});

test("score row mapping round-trips (null limit)", () => {
  const noLimit = { ...score, limit: null };
  assert.deepEqual(fromScoreRow(toScoreRow(noLimit)), noLimit);
});

test("score row splits limit into columns", () => {
  const row = toScoreRow(score);
  assert.equal(row.limit_amount, 5_000_000);
  assert.equal(row.limit_currency, "USDC");
  assert.equal(row.limit_period, "week");
});

test("factors are stored in the frontend display scale (value 0-100, contribution in points)", () => {
  const row = toScoreRow(score);
  const f = row.factors[0]!;
  assert.equal(f.value, 100); // normalized 1.0 -> 100%
  assert.equal(f.contribution, Math.round(1 * 0.3 * 850)); // 255 points
  assert.equal(f.value_raw, 1); // engine raw value preserved
});

test("settlement row mapping round-trips", () => {
  assert.deepEqual(fromSettlementRow(toSettlementRow(settlement)), settlement);
});

test("SupabaseStore builds PostgREST requests with auth headers", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify([toScoreRow(score)]), { status: 200 });
  }) as typeof fetch;

  const store = new SupabaseStore({ url: "https://proj.supabase.co/", serviceKey: "svc_key", fetchImpl });
  const got = await store.getScore("agent:sol:x");

  assert.deepEqual(got, score);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://proj.supabase.co/rest/v1/scores?agent_id=eq.agent%3Asol%3Ax&limit=1");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.apikey, "svc_key");
  assert.equal(headers.Authorization, "Bearer svc_key");
});

test("SupabaseStore.listScores applies sort/cursor semantics in-process", async () => {
  const rows = [
    toScoreRow({ ...score, agentId: "a", score: 800 }),
    toScoreRow({ ...score, agentId: "b", score: 600 }),
    toScoreRow({ ...score, agentId: "c", score: 700 }),
  ];
  const fetchImpl = (async () => new Response(JSON.stringify(rows), { status: 200 })) as typeof fetch;
  const store = new SupabaseStore({ url: "https://p.supabase.co", serviceKey: "k", fetchImpl });

  const page = await store.listScores({ sort: "score", limit: 2 });
  assert.deepEqual(page.data.map((r) => r.agentId), ["a", "c"]); // 800, 700
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, "c");
});
