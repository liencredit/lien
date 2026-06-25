import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../config.js";
import type { RegistryReader } from "../registry/reader.js";
import type { AttestationWriter } from "../service/attestation.js";
import { validateFeedbackAuth } from "../service/attestation.js";
import { validateLink } from "../service/linking.js";
import type { ScoringService } from "../service/scoring-service.js";
import { buildEvent, type WebhookDispatcher } from "../service/webhooks.js";
import type {
  ListScoresParams,
  ScoreRecord,
  SettlementRecord,
  SettlementStatus,
  Store,
} from "../storage/types.js";
import { sendError } from "./errors.js";
import {
  identityFromAgent,
  serializeCreditScore,
  serializeList,
  serializeReport,
  serializeSettlement,
} from "./serializers.js";

export interface RouteDeps {
  config: Config;
  store: Store;
  reader: RegistryReader;
  scoring: ScoringService;
  attestation: AttestationWriter;
  webhooks?: WebhookDispatcher;
}

const agentParams = z.object({ agent_id: z.string().min(1) });

const registryQuery = z.object({
  sort: z.enum(["score", "volume", "recent"]).optional(),
  status: z.enum(["good_standing", "on_watch", "defaulted"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  starting_after: z.string().optional(),
});

const settlementBody = z.object({
  agent_id: z.string().min(1),
  tab_id: z.string().min(1),
  amount: z.number().int().nonnegative(),
  on_time: z.boolean(),
  tx: z.string().optional(),
  counterparty: z.string().optional(),
});

const linkBody = z.object({
  wallet: z.string().min(1),
  wallet_signature: z.string().min(1),
  owner_signature: z.string().min(1),
});

/**
 * Resolve a stored score, computing+persisting it on demand if we've never
 * scored this agent (and it isn't a seeded synthetic). Returns null if the
 * agent has no 8004 identity and no stored score.
 */
async function getOrComputeScore(
  deps: RouteDeps,
  agentId: string,
): Promise<ScoreRecord | null> {
  // A linked wallet shares its canonical 8004 file.
  const canonical = (await deps.store.getAlias(agentId)) ?? agentId;
  const existing = await deps.store.getScore(canonical);
  if (existing) return existing;
  return deps.scoring.refreshAgent(canonical);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { config, store, reader, scoring, attestation, webhooks } = deps;

  // --- Bearer auth ---
  // Reads are public. Mutations (POST) require `Authorization: Bearer <key>` when
  // LIEN_API_KEY is configured; with no key set the API is fully open (dev only).
  app.addHook("preHandler", async (req, reply) => {
    if (!config.apiKey) return;
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token !== config.apiKey) {
      return sendError(reply, "authentication_error", "Missing or invalid API key");
    }
  });

  // GET /v1/score/:agent_id
  app.get("/v1/score/:agent_id", async (req, reply) => {
    const p = agentParams.safeParse(req.params);
    if (!p.success) return sendError(reply, "invalid_request", "agent_id is required", "agent_id");

    const score = await getOrComputeScore(deps, p.data.agent_id);
    if (!score) return sendError(reply, "agent_not_registered", "No 8004 identity and no settlement history for this agent", "agent_id");
    return serializeCreditScore(score);
  });

  // GET /v1/report/:agent_id
  app.get("/v1/report/:agent_id", async (req, reply) => {
    const p = agentParams.safeParse(req.params);
    if (!p.success) return sendError(reply, "invalid_request", "agent_id is required", "agent_id");

    const score = await getOrComputeScore(deps, p.data.agent_id);
    if (!score) return sendError(reply, "agent_not_registered", "No 8004 identity and no settlement history for this agent", "agent_id");

    // The score's agent_id is canonical (a linked wallet resolves to its 8004 file).
    const canonical = score.agentId;
    const agentRecord = await store.getAgent(canonical);
    const settlements = await scoring.collectLedger(canonical, 50);
    // Synthetic agents have no live 8004 identity to resolve.
    const resolved = agentRecord?.synthetic ? null : await reader.resolveAgent(canonical).catch(() => null);
    const identity = identityFromAgent(resolved, agentRecord?.name ?? null, agentRecord?.image ?? null);

    return serializeReport(score, identity, settlements);
  });

  // GET /v1/registry
  app.get("/v1/registry", async (req, reply) => {
    const q = registryQuery.safeParse(req.query);
    if (!q.success) return sendError(reply, "invalid_request", "invalid query parameters");

    const params: ListScoresParams = {
      sort: q.data.sort,
      status: q.data.status,
      limit: q.data.limit,
      startingAfter: q.data.starting_after,
    };
    const page = await store.listScores(params);
    return serializeList(page.data.map(serializeCreditScore), page.hasMore, page.nextCursor);
  });

  // POST /v1/settlements (idempotent)
  app.post("/v1/settlements", async (req, reply) => {
    const b = settlementBody.safeParse(req.body);
    if (!b.success) {
      return sendError(reply, "invalid_request", b.error.issues[0]?.message ?? "invalid body");
    }
    const body = b.data;
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
    const requestHash = hashBody(body);

    if (idempotencyKey) {
      const prior = await store.getIdempotency(idempotencyKey);
      if (prior) {
        if (prior.requestHash !== requestHash) {
          return sendError(reply, "idempotency_conflict", "Idempotency-Key reused with a different body");
        }
        const existing = await store.getSettlement(prior.settlementId);
        if (existing) return reply.code(200).send(serializeSettlement(existing));
      }
    }

    const status: SettlementStatus = body.on_time ? "settled" : "late";
    const settlement: SettlementRecord = {
      id: idempotencyKey ? `stl_${shortHash(idempotencyKey)}` : `stl_${shortHash(requestHash + Date.now())}`,
      agentId: body.agent_id,
      tabId: body.tab_id,
      counterparty: body.counterparty ?? null,
      amount: body.amount,
      currency: "USDC",
      status,
      onTime: body.on_time,
      occurredAt: new Date().toISOString(),
    };
    await store.insertSettlement(settlement);

    if (idempotencyKey) {
      await store.putIdempotency({ key: idempotencyKey, requestHash, settlementId: settlement.id });
    }

    // Feed the outcome back into the score (best-effort). 8004 agents are
    // re-scored with reputation; wallet-only agents get a ledger-only score from
    // this and prior settlements; seeded synthetic agents are left untouched.
    await scoring.refreshAgent(body.agent_id).catch(() => null);

    return reply.code(201).send(serializeSettlement(settlement));
  });

  // POST /v1/attest/:agent_id — write the current score back to the agent's 8004
  // record, gated by the agent's signed feedback authorization. The actual chain
  // write is delegated to the configured AttestationWriter (noop until a signer is
  // wired); `attested` reflects whether a real external write happened.
  app.post("/v1/attest/:agent_id", async (req, reply) => {
    const p = agentParams.safeParse(req.params);
    if (!p.success) return sendError(reply, "invalid_request", "agent_id is required", "agent_id");
    const agentId = p.data.agent_id;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const validation = validateFeedbackAuth(body.feedback_auth, agentId);
    if (!validation.ok) {
      return sendError(reply, "authorization_required", validation.reason, validation.param);
    }

    const score = await getOrComputeScore(deps, agentId);
    if (!score) return sendError(reply, "agent_not_registered", "Agent has no 8004 identity", "agent_id");

    const result = await attestation.write(score, body.feedback_auth as never);
    if (result.written && !score.attested) {
      const updated = { ...score, attested: true, updatedAt: new Date().toISOString() };
      await store.upsertScore(updated);
      webhooks?.emit(buildEvent("attestation.written", serializeCreditScore(updated)));
      return serializeCreditScore(updated);
    }
    return serializeCreditScore(score);
  });

  // POST /v1/agents/:agent_id/link — link a payment wallet to this agent's 8004
  // identity so they share one credit file. Requires signatures from BOTH the
  // wallet (proves control) and the 8004 owner (consents to absorb it), preventing
  // score impersonation and history theft. agent_id must be a real 8004 account.
  app.post("/v1/agents/:agent_id/link", async (req, reply) => {
    const p = agentParams.safeParse(req.params);
    if (!p.success) return sendError(reply, "invalid_request", "agent_id is required", "agent_id");
    const b = linkBody.safeParse(req.body);
    if (!b.success) return sendError(reply, "invalid_request", b.error.issues[0]?.message ?? "invalid body");

    const agent = await reader.resolveAgent(p.data.agent_id).catch(() => null);
    if (!agent) return sendError(reply, "agent_not_registered", "agent_id must be a registered 8004 agent", "agent_id");

    const validation = validateLink({
      agentId: p.data.agent_id,
      wallet: b.data.wallet,
      owner: agent.owner,
      walletSignature: b.data.wallet_signature,
      ownerSignature: b.data.owner_signature,
    });
    if (!validation.ok) {
      return sendError(reply, "authorization_required", validation.reason, validation.param);
    }

    await store.putAlias(b.data.wallet, p.data.agent_id);
    // Recompute so the wallet's settlements fold into the canonical file.
    const score = await scoring.refreshAgent(p.data.agent_id).catch(() => null);

    return reply.code(201).send({
      object: "link",
      wallet: b.data.wallet,
      agent_id: p.data.agent_id,
      score: score ? serializeCreditScore(score) : null,
    });
  });
}

function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}
