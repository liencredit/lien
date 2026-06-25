import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import type { ScoreRecord } from "../storage/types.js";
import {
  diffScoreEvents,
  signBody,
  WebhookDispatcher,
  type WebhookSubscriber,
  type WebhookTransport,
} from "./webhooks.js";

function score(overrides: Partial<ScoreRecord> = {}): ScoreRecord {
  return {
    agentId: "agent:sol:x",
    score: 700,
    band: "good",
    status: "good_standing",
    limit: null,
    attested: false,
    factors: [],
    updatedAt: "2026-06-23T00:00:00Z",
    ...overrides,
  };
}

/** Captures deliveries instead of making HTTP calls. */
class CapturingTransport implements WebhookTransport {
  readonly deliveries: Array<{ sub: WebhookSubscriber; rawBody: string; signature: string }> = [];
  async deliver(sub: WebhookSubscriber, rawBody: string, signature: string): Promise<boolean> {
    this.deliveries.push({ sub, rawBody, signature });
    return true;
  }
}

test("signBody matches an independent HMAC SHA-256 (same as the SDK verifier)", () => {
  const body = JSON.stringify({ hello: "world" });
  const secret = "whsec_test";
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  assert.equal(signBody(body, secret), expected);
});

test("diff: first computation emits score.updated only", () => {
  const events = diffScoreEvents(null, score());
  assert.deepEqual(events.map((e) => e.type), ["score.updated"]);
});

test("diff: no change emits nothing", () => {
  const prev = score();
  const next = score();
  assert.equal(diffScoreEvents(prev, next).length, 0);
});

test("diff: entering default emits score.updated + agent.defaulted", () => {
  const prev = score({ status: "good_standing", score: 700 });
  const next = score({ status: "defaulted", score: 520, band: "poor" });
  assert.deepEqual(diffScoreEvents(prev, next).map((e) => e.type), ["score.updated", "agent.defaulted"]);
});

test("diff: recovering emits score.updated + agent.recovered", () => {
  const prev = score({ status: "defaulted", score: 520, band: "poor" });
  const next = score({ status: "on_watch", score: 640, band: "fair" });
  assert.deepEqual(diffScoreEvents(prev, next).map((e) => e.type), ["score.updated", "agent.recovered"]);
});

test("dispatcher signs per-subscriber and the signature verifies", async () => {
  const transport = new CapturingTransport();
  const subs: WebhookSubscriber[] = [
    { url: "https://a.example/hook", secret: "secretA" },
    { url: "https://b.example/hook", secret: "secretB" },
  ];
  const dispatcher = new WebhookDispatcher(subs, transport);

  const [event] = diffScoreEvents(null, score());
  await dispatcher.deliverAll(event!);

  assert.equal(transport.deliveries.length, 2);
  for (const d of transport.deliveries) {
    const expected = createHmac("sha256", d.sub.secret).update(d.rawBody).digest("hex");
    assert.equal(d.signature, expected);
    // Distinct secrets => distinct signatures over the same body.
  }
  assert.notEqual(transport.deliveries[0]!.signature, transport.deliveries[1]!.signature);
});

test("dispatcher with no subscribers is a no-op", () => {
  const transport = new CapturingTransport();
  const dispatcher = new WebhookDispatcher([], transport);
  assert.equal(dispatcher.enabled, false);
  dispatcher.emit(diffScoreEvents(null, score())[0]!);
  assert.equal(transport.deliveries.length, 0);
});
