import { createHmac } from "node:crypto";
import { serializeCreditScore } from "../api/serializers.js";
import type { ScoreRecord } from "../storage/types.js";

export type WebhookEventType =
  | "score.updated"
  | "agent.defaulted"
  | "agent.recovered"
  | "tab.settlement_due"
  | "attestation.written";

export interface WebhookEvent {
  id: string;
  type: WebhookEventType;
  created: string;
  data: unknown;
}

export interface WebhookSubscriber {
  url: string;
  secret: string;
}

export interface WebhookTransport {
  /** Deliver a signed body to a subscriber. Returns true on a 2xx. */
  deliver(sub: WebhookSubscriber, rawBody: string, signature: string): Promise<boolean>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** HMAC SHA-256 of the raw body, hex — matches the SDK's `Lien.webhooks.constructEvent`. */
export function signBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

let counter = 0;
function eventId(): string {
  counter = (counter + 1) % 1_000_000;
  return `evt_${Date.now().toString(36)}${counter.toString(36).padStart(4, "0")}`;
}

export function buildEvent(type: WebhookEventType, data: unknown, now = Date.now()): WebhookEvent {
  return { id: eventId(), type, created: new Date(now).toISOString(), data };
}

/**
 * Compare a previous and next stored score and return the events the change
 * implies. `prev` is null on first computation.
 */
export function diffScoreEvents(prev: ScoreRecord | null, next: ScoreRecord): WebhookEvent[] {
  const events: WebhookEvent[] = [];
  const payload = serializeCreditScore(next);

  const changed = !prev || prev.score !== next.score || prev.band !== next.band || prev.status !== next.status;
  if (changed) events.push(buildEvent("score.updated", payload));

  const wasDefaulted = prev?.status === "defaulted";
  const isDefaulted = next.status === "defaulted";
  if (!wasDefaulted && isDefaulted) {
    events.push(buildEvent("agent.defaulted", payload));
  } else if (wasDefaulted && !isDefaulted) {
    events.push(buildEvent("agent.recovered", payload));
  }

  return events;
}

/**
 * HTTP transport with bounded exponential backoff. Best-effort: a fully failed
 * delivery is logged, not thrown (webhooks never block the originating request).
 */
export class HttpWebhookTransport implements WebhookTransport {
  constructor(
    private readonly opts: { attempts?: number; baseDelayMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
  ) {}

  async deliver(sub: WebhookSubscriber, rawBody: string, signature: string): Promise<boolean> {
    const attempts = this.opts.attempts ?? 3;
    const base = this.opts.baseDelayMs ?? 200;
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 5_000);
        const res = await fetchImpl(sub.url, {
          method: "POST",
          headers: { "content-type": "application/json", "LIEN-Signature": signature },
          body: rawBody,
          signal: controller.signal,
        }).finally(() => clearTimeout(timer));
        if (res.ok) return true;
      } catch {
        // fall through to backoff
      }
      if (attempt < attempts - 1) await sleep(base * 2 ** attempt);
    }
    return false;
  }
}

/** Fans events out to all subscribers. Fire-and-forget from the caller's view. */
export class WebhookDispatcher {
  constructor(
    private readonly subscribers: WebhookSubscriber[],
    private readonly transport: WebhookTransport,
    private readonly logger?: Logger,
  ) {}

  get enabled(): boolean {
    return this.subscribers.length > 0;
  }

  /** Dispatch one event to all subscribers without blocking the caller. */
  emit(event: WebhookEvent): void {
    if (!this.enabled) return;
    void this.deliverAll(event);
  }

  /** Dispatch many events. */
  emitAll(events: WebhookEvent[]): void {
    for (const e of events) this.emit(e);
  }

  /** Await delivery (used in tests). */
  async deliverAll(event: WebhookEvent): Promise<void> {
    const rawBody = JSON.stringify(event);
    await Promise.all(
      this.subscribers.map(async (sub) => {
        const ok = await this.transport.deliver(sub, rawBody, signBody(rawBody, sub.secret));
        if (ok) this.logger?.info(`webhook ${event.type} -> ${sub.url}`);
        else this.logger?.warn(`webhook ${event.type} -> ${sub.url} failed`);
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
