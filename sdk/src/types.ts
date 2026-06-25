// Public API types — mirror the objects in ../../LIEN-docs.md. Clients should
// ignore unknown fields (additive changes are non-breaking).

export type Band = "poor" | "fair" | "good" | "very_good" | "excellent";
export type Status = "good_standing" | "on_watch" | "defaulted";
export type Period = "day" | "week" | "month";
export type SettlementStatus = "settled" | "late" | "defaulted";
export type RegistrySort = "score" | "volume" | "recent";

export interface Limit {
  amount: number;
  currency: string;
  period: Period;
}

export interface CreditScore {
  object: "credit_score";
  agent_id: string;
  score: number;
  band: Band;
  status: Status;
  limit: Limit | null;
  attested: boolean;
  updated_at: string;
}

export interface Factor {
  key: "on_time_rate" | "volume" | "account_age" | "counterparty_diversity" | "defaults";
  value: number;
  weight: number;
  contribution: number;
}

export interface Settlement {
  object: "settlement";
  id: string;
  agent_id: string;
  tab_id: string | null;
  counterparty: string | null;
  amount: number;
  currency: string;
  status: SettlementStatus;
  occurred_at: string;
}

export interface Report extends Omit<CreditScore, "object"> {
  object: "report";
  identity: { name: string | null; image: string | null; verified_8004: boolean };
  factors: Factor[];
  recent_settlements: Settlement[];
}

export interface Page<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface RegistryParams {
  sort?: RegistrySort;
  status?: Status;
  limit?: number;
  starting_after?: string;
}

export interface CreateSettlementBody {
  agent_id: string;
  tab_id: string;
  amount: number;
  on_time: boolean;
  tx?: string;
  counterparty?: string;
}

export interface FeedbackAuth {
  client: string;
  agent_id: string;
  expiry: string;
  signature: string;
}

/** A normalized x402 payment event, ready to report to LIEN as a settlement. */
export interface X402Payment {
  /** The paying agent's wallet — becomes the LIEN `agent_id`. */
  payer: string;
  /** Amount paid, in minor units (USDC, 6 decimals). */
  amount: number;
  /** The resource server / counterparty being paid. Feeds counterparty diversity. */
  resource: string;
  /** On-chain settlement signature, if known. */
  tx?: string;
  /** The post-paid tab this closes. Defaults to a generated id (also the idempotency key). */
  tabId?: string;
  /**
   * Whether it settled on time. Prepaid x402 is always on time (you don't get the
   * resource unless you pay), so this defaults to `true`. Post-paid tabs set it
   * from the actual outcome.
   */
  onTime?: boolean;
}

/** A credit decision for an x402 request, derived from the agent's LIEN standing. */
export interface X402Authorization {
  /** Whether to extend post-paid terms. `false` → require prepay. */
  creditworthy: boolean;
  /** Recommended credit ceiling, or `null` if not eligible. */
  limit: Limit | null;
  /** The full score, or `null` if the agent has no LIEN file yet. */
  score: CreditScore | null;
}

export interface WebhookEvent<T = unknown> {
  id: string;
  type:
    | "score.updated"
    | "agent.defaulted"
    | "agent.recovered"
    | "tab.settlement_due"
    | "attestation.written";
  created: string;
  data: T;
}

export type ErrorType =
  | "invalid_request"
  | "authentication_error"
  | "authorization_required"
  | "not_found"
  | "agent_not_registered"
  | "idempotency_conflict"
  | "rate_limited"
  | "api_error";
