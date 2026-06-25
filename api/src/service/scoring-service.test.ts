import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryStore } from "../storage/memory.js";
import type { SettlementRecord } from "../storage/types.js";
import { ScoringService, ledgerFromSettlements } from "./scoring-service.js";

const settlement = (id: string, agentId: string, amount: number, cp: string): SettlementRecord => ({
  id,
  agentId,
  tabId: `tab_${id}`,
  counterparty: cp,
  amount,
  currency: "USDC",
  status: "settled",
  onTime: true,
  occurredAt: new Date().toISOString(),
});

test("collectLedger unions a canonical agent with its linked wallets", async () => {
  const store = new MemoryStore();
  const AGENT = "8004agent";
  const WALLET = "x402wallet";

  await store.insertSettlement(settlement("a1", AGENT, 10_000_000, "cpA"));
  await store.insertSettlement(settlement("w1", WALLET, 20_000_000, "cpB"));
  await store.insertSettlement(settlement("w2", WALLET, 30_000_000, "cpC"));

  // No link yet → only the agent's own settlement.
  const scoring = new ScoringService({} as never, store);
  assert.equal((await scoring.collectLedger(AGENT, 100)).length, 1);

  // After linking, the wallet's settlements fold into the canonical file.
  await store.putAlias(WALLET, AGENT);
  const merged = await scoring.collectLedger(AGENT, 100);
  assert.equal(merged.length, 3);

  const { signal, counterparties } = ledgerFromSettlements(merged);
  assert.equal(signal.totalVolume, 60_000_000);
  assert.equal(counterparties.sort().join(","), "cpA,cpB,cpC");
});
