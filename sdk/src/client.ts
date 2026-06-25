import { createHmac, timingSafeEqual } from "node:crypto";
import { LienError } from "./errors.js";
import type {
  CreateSettlementBody,
  CreditScore,
  FeedbackAuth,
  Page,
  RegistryParams,
  Report,
  Settlement,
  WebhookEvent,
  X402Authorization,
  X402Payment,
} from "./types.js";

const NETWORK_BASE_URLS = {
  mainnet: "https://lien-api-production.up.railway.app/v1",
  devnet: "https://lien-api-production.up.railway.app/v1",
} as const;

export interface LienOptions {
  apiKey: string;
  /** Pick a hosted environment. Ignored if `baseUrl` is provided. */
  network?: "mainnet" | "devnet";
  /** Override the base URL (e.g. http://127.0.0.1:8787/v1 for local dev). */
  baseUrl?: string;
  /** Per-request timeout in ms (default 20000). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class Lien {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  readonly settlements: {
    create(body: CreateSettlementBody, opts?: { idempotencyKey?: string }): Promise<Settlement>;
  };

  /**
   * x402 helpers. LIEN scores agents by their payment wallet, so x402 traffic is a
   * first-class data source — no 8004 registration required.
   */
  readonly x402: {
    /** Decide whether to extend post-paid terms to an x402 payer. Unknown agents → prepay. */
    authorize(payer: string): Promise<X402Authorization>;
    /** Report an x402 payment to LIEN as a settlement so it feeds the payer's score. */
    reportPayment(payment: X402Payment): Promise<Settlement>;
  };

  constructor(opts: LienOptions) {
    if (!opts.apiKey) throw new Error("Lien: apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? NETWORK_BASE_URLS[opts.network ?? "mainnet"]).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) throw new Error("Lien: no global fetch; pass options.fetch");

    this.settlements = {
      create: (body, o) =>
        this.request<Settlement>("POST", "/settlements", {
          body,
          headers: o?.idempotencyKey ? { "Idempotency-Key": o.idempotencyKey } : undefined,
        }),
    };

    this.x402 = {
      authorize: async (payer) => {
        try {
          const score = await this.check(payer);
          const creditworthy = score.status !== "defaulted" && score.limit !== null;
          return { creditworthy, limit: score.limit, score };
        } catch (e) {
          // No LIEN file yet (no 8004 identity and no history) → not creditworthy.
          if (e instanceof LienError && e.type === "agent_not_registered") {
            return { creditworthy: false, limit: null, score: null };
          }
          throw e;
        }
      },
      reportPayment: (p) => {
        const tabId = p.tabId ?? `x402_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return this.settlements.create(
          {
            agent_id: p.payer,
            tab_id: tabId,
            amount: p.amount,
            on_time: p.onTime ?? true,
            counterparty: p.resource,
            ...(p.tx ? { tx: p.tx } : {}),
          },
          { idempotencyKey: tabId },
        );
      },
    };
  }

  /** Compact score. `GET /score/:agent_id`. */
  check(agentId: string): Promise<CreditScore> {
    return this.request<CreditScore>("GET", `/score/${encodeURIComponent(agentId)}`);
  }

  /** Full report. `GET /report/:agent_id`. */
  report(agentId: string): Promise<Report> {
    return this.request<Report>("GET", `/report/${encodeURIComponent(agentId)}`);
  }

  /** Paginated registry. `GET /registry`. */
  registry(params: RegistryParams = {}): Promise<Page<CreditScore>> {
    const qs = new URLSearchParams();
    if (params.sort) qs.set("sort", params.sort);
    if (params.status) qs.set("status", params.status);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.starting_after) qs.set("starting_after", params.starting_after);
    const suffix = qs.toString() ? `?${qs}` : "";
    return this.request<Page<CreditScore>>("GET", `/registry${suffix}`);
  }

  /** Write the current score back to the agent's 8004 record. `POST /attest/:agent_id`. */
  attest(agentId: string, opts: { feedbackAuth: FeedbackAuth }): Promise<CreditScore> {
    return this.request<CreditScore>("POST", `/attest/${encodeURIComponent(agentId)}`, {
      body: { feedback_auth: opts.feedbackAuth },
    });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      const json = text ? JSON.parse(text) : {};

      if (!res.ok) {
        const e = json?.error ?? {};
        throw new LienError(res.status, e.type ?? "api_error", e.message ?? res.statusText, e.param);
      }
      return json as T;
    } catch (err) {
      if (err instanceof LienError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LienError(408, "api_error", `request timed out after ${this.timeoutMs}ms`);
      }
      throw new LienError(0, "api_error", err instanceof Error ? err.message : "request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Verify + parse a webhook delivery. Throws if the signature doesn't match. */
  static webhooks = {
    constructEvent<T = unknown>(rawBody: string, signature: string, secret: string): WebhookEvent<T> {
      const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(signature);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new LienError(400, "invalid_request", "webhook signature mismatch");
      }
      return JSON.parse(rawBody) as WebhookEvent<T>;
    },
  };
}
