import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { Lien } from "./client.js";
import { LienError } from "./errors.js";

function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test("check() hits /score with bearer auth and parses the score", async () => {
  let seenAuth = "";
  let seenUrl = "";
  const lien = new Lien({
    apiKey: "sk_test_abc",
    baseUrl: "http://local/v1",
    fetch: stubFetch((url, init) => {
      seenUrl = url;
      seenAuth = (init.headers as Record<string, string>).Authorization ?? "";
      return {
        status: 200,
        body: { object: "credit_score", agent_id: "a", score: 700, band: "good", status: "good_standing", limit: null, attested: false, updated_at: "x" },
      };
    }),
  });

  const score = await lien.check("agent:sol:x y");
  assert.equal(score.score, 700);
  assert.equal(seenAuth, "Bearer sk_test_abc");
  assert.equal(seenUrl, "http://local/v1/score/agent%3Asol%3Ax%20y");
});

test("registry() serializes query params", async () => {
  let seenUrl = "";
  const lien = new Lien({
    apiKey: "k",
    baseUrl: "http://local/v1",
    fetch: stubFetch((url) => {
      seenUrl = url;
      return { status: 200, body: { object: "list", data: [], has_more: false, next_cursor: null } };
    }),
  });
  await lien.registry({ sort: "volume", status: "on_watch", limit: 10, starting_after: "z" });
  assert.match(seenUrl, /sort=volume/);
  assert.match(seenUrl, /status=on_watch/);
  assert.match(seenUrl, /limit=10/);
  assert.match(seenUrl, /starting_after=z/);
});

test("settlements.create() forwards the Idempotency-Key header", async () => {
  let seenKey: string | undefined;
  const lien = new Lien({
    apiKey: "k",
    baseUrl: "http://local/v1",
    fetch: stubFetch((_url, init) => {
      seenKey = (init.headers as Record<string, string>)["Idempotency-Key"];
      return { status: 201, body: { object: "settlement", id: "stl_1", agent_id: "a", tab_id: "t", counterparty: null, amount: 1, currency: "USDC", status: "settled", occurred_at: "x" } };
    }),
  });
  const s = await lien.settlements.create(
    { agent_id: "a", tab_id: "t", amount: 1, on_time: true },
    { idempotencyKey: "idem-1" },
  );
  assert.equal(s.id, "stl_1");
  assert.equal(seenKey, "idem-1");
});

test("non-2xx maps to a typed LienError", async () => {
  const lien = new Lien({
    apiKey: "k",
    baseUrl: "http://local/v1",
    fetch: stubFetch(() => ({
      status: 404,
      body: { error: { type: "agent_not_registered", message: "nope", param: "agent_id" } },
    })),
  });
  await assert.rejects(
    () => lien.check("a"),
    (e: unknown) => {
      assert.ok(e instanceof LienError);
      assert.equal(e.status, 404);
      assert.equal(e.type, "agent_not_registered");
      assert.equal(e.retryable, false);
      return true;
    },
  );
});

test("webhooks.constructEvent verifies a valid signature and rejects a bad one", () => {
  const secret = "whsec_test";
  const event = { id: "evt_1", type: "agent.defaulted", created: "x", data: { agent_id: "a" } };
  const raw = JSON.stringify(event);
  const sig = createHmac("sha256", secret).update(raw).digest("hex");

  const parsed = Lien.webhooks.constructEvent(raw, sig, secret);
  assert.equal(parsed.type, "agent.defaulted");

  assert.throws(() => Lien.webhooks.constructEvent(raw, "deadbeef", secret), LienError);
});
