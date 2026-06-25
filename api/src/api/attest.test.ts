import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { GraphQLClient } from "../registry/graphql.js";
import { RegistryReader } from "../registry/reader.js";
import {
  type AttestationResult,
  type AttestationWriter,
  type FeedbackAuth,
  validateFeedbackAuth,
} from "../service/attestation.js";
import { ScoringService } from "../service/scoring-service.js";
import { seedStore } from "../seed/data.js";
import { MemoryStore } from "../storage/memory.js";
import type { Config } from "../config.js";
import { registerRoutes } from "./routes.js";

const AGENT = "agent:sol:7xKq9b9c4Atlas"; // seeded synthetic, has a stored score

const baseConfig: Config = {
  cluster: "devnet",
  graphqlUrl: "http://unused.local",
  port: 0,
  host: "127.0.0.1",
  seed: false,
  apiKey: null,
  webhooks: [],
  supabase: null,
  rateLimitPerMin: 0,
  seedRealCount: 0,
};

function validAuth(): FeedbackAuth {
  return {
    client: "lien.credit",
    agent_id: AGENT,
    expiry: new Date(Date.now() + 86_400_000).toISOString(),
    signature: "0xdeadbeef",
  };
}

async function buildApp(writer: AttestationWriter) {
  const store = new MemoryStore();
  await seedStore(store, Date.parse("2026-06-23T00:00:00Z"));
  const reader = new RegistryReader(new GraphQLClient({ url: baseConfig.graphqlUrl }));
  const scoring = new ScoringService(reader, store);
  const app = Fastify();
  registerRoutes(app, { config: baseConfig, store, reader, scoring, attestation: writer });
  return { app, store };
}

test("validateFeedbackAuth accepts a well-formed, unexpired, matching auth", () => {
  assert.deepEqual(validateFeedbackAuth(validAuth(), AGENT), { ok: true });
});

test("validateFeedbackAuth rejects expiry in the past", () => {
  const r = validateFeedbackAuth({ ...validAuth(), expiry: "2000-01-01T00:00:00Z" }, AGENT);
  assert.equal(r.ok, false);
});

test("validateFeedbackAuth rejects agent_id mismatch", () => {
  const r = validateFeedbackAuth({ ...validAuth(), agent_id: "agent:sol:other" }, AGENT);
  assert.equal(r.ok, false);
});

test("validateFeedbackAuth rejects missing fields", () => {
  const r = validateFeedbackAuth({ client: "lien.credit" }, AGENT);
  assert.equal(r.ok, false);
});

test("attest with a real writer flips attested to true", async () => {
  const writer: AttestationWriter = {
    async write(): Promise<AttestationResult> {
      return { written: true, mode: "onchain", ref: "sig123" };
    },
  };
  const { app, store } = await buildApp(writer);

  const res = await app.inject({
    method: "POST",
    url: `/v1/attest/${encodeURIComponent(AGENT)}`,
    payload: { feedback_auth: validAuth() },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().attested, true);
  assert.equal((await store.getScore(AGENT))?.attested, true);
  await app.close();
});

test("attest with the noop writer leaves attested false", async () => {
  const writer: AttestationWriter = {
    async write(): Promise<AttestationResult> {
      return { written: false, mode: "noop" };
    },
  };
  const { app } = await buildApp(writer);
  const res = await app.inject({
    method: "POST",
    url: `/v1/attest/${encodeURIComponent(AGENT)}`,
    payload: { feedback_auth: validAuth() },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().attested, false);
  await app.close();
});

test("attest rejects an expired authorization with 403", async () => {
  const writer: AttestationWriter = {
    async write(): Promise<AttestationResult> {
      return { written: true, mode: "onchain" };
    },
  };
  const { app } = await buildApp(writer);
  const res = await app.inject({
    method: "POST",
    url: `/v1/attest/${encodeURIComponent(AGENT)}`,
    payload: { feedback_auth: { ...validAuth(), expiry: "2000-01-01T00:00:00Z" } },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.type, "authorization_required");
  await app.close();
});
