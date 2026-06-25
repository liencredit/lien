import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { Config } from "./config.js";
import { registerRoutes } from "./api/routes.js";
import { GraphQLClient } from "./registry/graphql.js";
import { RegistryReader } from "./registry/reader.js";
import { seedStore } from "./seed/data.js";
import { createAttestationWriter } from "./service/attestation.js";
import { ScoringService } from "./service/scoring-service.js";
import { HttpWebhookTransport, WebhookDispatcher } from "./service/webhooks.js";
import { createStore } from "./storage/index.js";

/** Score the top-N real 8004 agents into the store (best-effort, non-blocking). */
async function seedRealAgents(
  reader: RegistryReader,
  scoring: ScoringService,
  count: number,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  try {
    const agents = await reader.listAgents({ first: count, orderBy: "totalFeedback" });
    let ok = 0;
    for (const a of agents) {
      try {
        if (await scoring.refreshAgent(a.id)) ok++;
      } catch {
        // skip individual failures; keep seeding the rest
      }
    }
    log.info(`seeded ${ok}/${agents.length} real mainnet agents into the registry`);
  } catch (e) {
    log.warn(`real-agent seed failed: ${(e as Error).message}`);
  }
}

export async function buildServer(config: Config): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  // Public read API + browser dev playground → permissive CORS. Writes are still
  // gated by the Bearer key, so reflecting any origin is safe here.
  await app.register(cors, { origin: true });

  if (config.rateLimitPerMin > 0) {
    await app.register(rateLimit, {
      max: config.rateLimitPerMin,
      timeWindow: "1 minute",
      // Health checks shouldn't burn quota.
      allowList: (req) => req.url === "/health",
      errorResponseBuilder: () => ({
        error: { type: "rate_limited", message: "Too many requests; retry after a short backoff." },
      }),
    });
  }

  const { store, backend } = await createStore({
    databaseUrl: config.databaseUrl,
    supabase: config.supabase,
  });
  app.log.info(`storage: ${backend}`);
  const reader = new RegistryReader(new GraphQLClient({ url: config.graphqlUrl }));
  const webhooks = new WebhookDispatcher(config.webhooks, new HttpWebhookTransport(), {
    info: (m) => app.log.info(m),
    warn: (m) => app.log.warn(m),
  });
  const scoring = new ScoringService(reader, store, webhooks);
  const attestation = createAttestationWriter();

  if (config.seed) {
    const result = await seedStore(store);
    app.log.info(`seeded ${result.agents} synthetic agents, ${result.settlements} settlements`);
  }

  // Populate the registry with real mainnet agents in the background so it mirrors
  // the public site without blocking boot / health checks.
  if (config.seedRealCount > 0) {
    void seedRealAgents(reader, scoring, config.seedRealCount, app.log);
  }
  if (webhooks.enabled) {
    app.log.info(`webhooks: ${config.webhooks.length} subscriber(s)`);
  }

  app.get("/health", async () => ({
    status: "ok",
    cluster: config.cluster,
    graphqlUrl: config.graphqlUrl,
    seeded: config.seed,
  }));

  registerRoutes(app, { config, store, reader, scoring, attestation, webhooks });

  // --- 8004 read passthrough (debug; bypasses storage, reads 8004 directly) ---
  const agentParams = z.object({ id: z.string().min(1) });

  app.get("/v1/_8004/stats", async () => reader.globalStats());

  app.get("/v1/_8004/agent/:id", async (req, reply) => {
    const parsed = agentParams.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { type: "invalid_request", message: "id is required", param: "id" },
      });
    }
    const agent = await reader.resolveAgent(parsed.data.id);
    if (!agent) {
      return reply.code(404).send({
        error: { type: "agent_not_registered", message: "no such 8004 agent", param: "id" },
      });
    }
    return agent;
  });

  app.get("/v1/_8004/agent/:id/feedback", async (req, reply) => {
    const parsed = agentParams.safeParse(req.params);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { type: "invalid_request", message: "id is required", param: "id" },
      });
    }
    const feedback = await reader.getFeedback(parsed.data.id);
    return { object: "list", data: feedback };
  });

  return app;
}
