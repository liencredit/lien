# LIEN API Reference

LIEN scores the creditworthiness of autonomous agents from their on-chain payment
history and exposes it over a REST API and a TypeScript SDK. Use it to decide which
agents to extend post-paid terms to, and to react when an agent's standing changes.

**Base URLs**

| Environment | URL |
|---|---|
| Live (mainnet) | `https://lien-api-production.up.railway.app/v1` |

> A vanity domain (`https://api.lien.credit/v1`) can be mapped to this service later;
> the Railway URL above is the canonical live endpoint today.

All requests are HTTPS. All responses are JSON. All timestamps are RFC 3339 (UTC).
Monetary amounts are integer minor units (USDC, 6 decimals) unless stated otherwise.

> **Availability.** Scoring, reads (`/score`, `/report`, `/registry`), settlement
> reporting, webhooks, and rate limiting are live and read real mainnet 8004 data.
> Attestation (`POST /attest`) validates authorization and is wired end-to-end, but
> the on-chain write is a no-op until the LIEN signer + program are deployed to
> mainnet — `attested` stays `false` until then.

---

## Authentication

**Reads are public.** `GET /score`, `GET /report`, and `GET /registry` need no
credentials — point a client at them directly.

**Writes require a key.** `POST /settlements` and `POST /attest` require an API key
in the `Authorization` header:

```
Authorization: Bearer sk_live_2pQ...
```

Keys are secret — use them server-side only. A missing or invalid key on a write
returns `401 authentication_error`.

```bash
# read — no key needed
curl https://lien-api-production.up.railway.app/v1/score/agent:sol:7xKq9b9c4

# write — key required
curl -X POST https://lien-api-production.up.railway.app/v1/settlements \
  -H "Authorization: Bearer $LIEN_API_KEY" -H "content-type: application/json" \
  -d '{"agent_id":"agent:sol:7xKq9b9c4","tab_id":"tab_91","amount":120000000,"on_time":true}'
```

---

## Versioning

The API is versioned in the path (`/v1`). Additive changes — new fields, new
endpoints, new enum members — are non-breaking and may ship at any time, so write
clients that ignore unknown fields. Breaking changes ship under a new path version.

---

## Rate limits

Requests are rate-limited per client IP (default **120 requests / minute**). Every
response carries:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit` | Requests allowed in the current window. |
| `x-ratelimit-remaining` | Requests left in the window. |
| `x-ratelimit-reset` | Seconds until the window resets. |

Exceeding the limit returns `429 rate_limited` with a `retry-after` header. `/health`
is exempt. Back off and retry on `429`.

---

## Errors

Errors return a non-2xx status and a body of the form:

```json
{
  "error": {
    "type": "invalid_request",
    "message": "agent_id is required",
    "param": "agent_id"
  }
}
```

| HTTP | `type` | When |
|---|---|---|
| 400 | `invalid_request` | Malformed parameter or body. |
| 401 | `authentication_error` | Missing or invalid API key. |
| 403 | `authorization_required` | Write requires the agent's feedback authorization. |
| 404 | `not_found` | No such resource. |
| 404 | `agent_not_registered` | No 8004 identity and no settlement history for this agent. |
| 409 | `idempotency_conflict` | Idempotency key reused with a different body. |
| 429 | `rate_limited` | Too many requests. |
| 5xx | `api_error` | Something broke on our side; safe to retry. |

`5xx` and `429` are safe to retry with exponential backoff. `4xx` are not — fix the
request first.

---

## Pagination

List endpoints are cursor-paginated. Pass `limit` (1–100, default 25) and
`starting_after` (the `id` of the last item from the previous page).

```json
{
  "object": "list",
  "data": [ /* ... */ ],
  "has_more": true,
  "next_cursor": "agent:sol:4kP2..."
}
```

---

## Objects

### The `credit_score` object

| Field | Type | Description |
|---|---|---|
| `agent_id` | `string` | The agent's identifier — an 8004 account address or a payment wallet (x402). See [Identity model](#identity-model). |
| `score` | `integer` | 300–850. |
| `band` | `enum` | `poor` \| `fair` \| `good` \| `very_good` \| `excellent`. |
| `status` | `enum` | `good_standing` \| `on_watch` \| `defaulted`. |
| `limit` | `limit` \| `null` | Recommended post-paid ceiling; `null` if not eligible. |
| `attested` | `boolean` | Whether this score is written to the agent's 8004 record. |
| `updated_at` | `string` | Last recomputation time. |

```json
{
  "object": "credit_score",
  "agent_id": "agent:sol:7xKq9b9c4",
  "score": 782,
  "band": "very_good",
  "status": "good_standing",
  "limit": { "amount": 500000000, "currency": "USDC", "period": "week" },
  "attested": true,
  "updated_at": "2026-06-21T09:12:00Z"
}
```

### The `limit` object

| Field | Type | Description |
|---|---|---|
| `amount` | `integer` | Ceiling in minor units (500000000 = 500 USDC). |
| `currency` | `string` | Settlement asset. |
| `period` | `enum` | `day` \| `week` \| `month`. |

### The `factor` object

| Field | Type | Description |
|---|---|---|
| `key` | `enum` | `on_time_rate` \| `volume` \| `account_age` \| `counterparty_diversity` \| `defaults`. |
| `value` | `number` | Raw measured value (e.g. `0.99` for a rate, `480000` for volume). |
| `weight` | `number` | Factor weight in the model (0–1). |
| `contribution` | `number` | Weighted share this factor added to the final score (0–1). |
| `normalized` | `number` | The factor's value mapped to 0–1 before weighting. |
| `bootstrapped` | `boolean` | `true` if inferred from 8004 reputation (no LIEN ledger yet). |

### The `report` object

Everything in `credit_score`, plus:

| Field | Type | Description |
|---|---|---|
| `identity` | `object` | `{ name, image, verified_8004 }`. From the 8004 registration file when present; `verified_8004` is `false` for wallet-only agents. |
| `factors` | `factor[]` | Per-factor breakdown. |
| `recent_settlements` | `settlement[]` | Most recent settlements (max 50). |

### The `settlement` object

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Settlement id. |
| `agent_id` | `string` | The agent that settled. |
| `tab_id` | `string` \| `null` | The post-paid tab this closed, if any. |
| `counterparty` | `string` | Truncated counterparty address. |
| `amount` | `integer` | Minor units. |
| `currency` | `string` | Asset. |
| `status` | `enum` | `settled` \| `late` \| `defaulted`. |
| `occurred_at` | `string` | Timestamp. |

---

## Endpoints

### Retrieve a score

```
GET /score/:agent_id
```

Returns the `credit_score` object. Errors: `agent_not_registered`, `not_found`.

```bash
curl https://lien-api-production.up.railway.app/v1/score/agent:sol:7xKq9b9c4
```

### Retrieve a full report

```
GET /report/:agent_id
```

Returns the `report` object (score + identity + factors + recent settlements). This
is what the public profile page renders.

### List the registry

```
GET /registry
```

| Query param | Type | Description |
|---|---|---|
| `sort` | `enum` | `score` (default, desc) \| `volume` \| `recent`. |
| `status` | `enum` | Filter by `good_standing` \| `on_watch` \| `defaulted`. |
| `limit` | `integer` | 1–100. |
| `starting_after` | `string` | Cursor. |

Returns a paginated list of `credit_score` objects.

### Report a settlement outcome

```
POST /settlements
```

Call this after an agent settles (or misses) a tab so the outcome feeds its next
score. Idempotent — pass an `Idempotency-Key` header; replays with the same key and
body return the original result, a different body returns `409`.

| Body field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | `string` | yes | The agent. |
| `tab_id` | `string` | yes | The tab being settled. |
| `amount` | `integer` | yes | Minor units settled. |
| `on_time` | `boolean` | yes | Whether it settled within the period. |
| `counterparty` | `string` | no | The paying/receiving party (e.g. resource server). Feeds `counterparty_diversity`. |
| `tx` | `string` | no | Settlement transaction signature. |

```bash
curl -X POST https://lien-api-production.up.railway.app/v1/settlements \
  -H "Authorization: Bearer $LIEN_API_KEY" \
  -H "Idempotency-Key: stl_8f21a" \
  -d '{"agent_id":"agent:sol:7xKq9b9c4","tab_id":"tab_91","amount":120000000,"on_time":true}'
```

Returns the created `settlement` object. A `defaulted` result transitions the agent
to `defaulted` and emits `agent.defaulted` (see Webhooks).

### Create an attestation

```
POST /attest/:agent_id
```

Writes the agent's current score to its 8004 reputation record as a signed
snapshot, so other 8004-aware services can read it. Requires the agent's feedback
authorization — see [Identity model](#identity-model). Without it, returns
`403 authorization_required`.

> The on-chain write is pending the mainnet signer/program deploy (see
> **Availability**). Today this validates the authorization and returns the score;
> `attested` flips to `true` once the writer is live.

| Body field | Type | Required | Description |
|---|---|---|---|
| `feedback_auth` | `object` | yes | The agent's signed authorization (see below). |

Returns the updated `credit_score` with `attested: true`.

---

## Webhooks

Register an endpoint to receive events instead of polling. LIEN POSTs an `event`
object to your URL:

```json
{
  "id": "evt_2a9...",
  "type": "score.updated",
  "created": "2026-06-21T09:12:00Z",
  "data": { /* the affected credit_score or settlement object */ }
}
```

| Event type | Fires when |
|---|---|
| `score.updated` | An agent's score, band, or status changes. |
| `agent.defaulted` | An agent enters `defaulted`. |
| `agent.recovered` | A `defaulted` agent returns to `on_watch`/`good_standing`. |
| `attestation.written` | A score was written on-chain to an agent's 8004 record. |
| `tab.settlement_due` | _(planned)_ A tab's settlement period is closing. |

**Verify signatures.** Each delivery includes a `LIEN-Signature` header — an HMAC
SHA-256 of the raw body keyed with your webhook secret. Reject any request that
doesn't match.

```ts
import { Lien } from "@lien/sdk";

const event = Lien.webhooks.constructEvent(rawBody, sig, webhookSecret);
if (event.type === "agent.defaulted") closeTab(event.data.agent_id);
```

Deliveries that don't get a `2xx` are retried with exponential backoff for 24h.

---

## TypeScript SDK

```bash
npm install @lien/sdk
```

```ts
import { Lien } from "@lien/sdk";

const lien = new Lien({
  apiKey: process.env.LIEN_API_KEY!,   // sk_live_* or sk_test_*
  network: "mainnet"                   // or "devnet"
});
```

| Method | Returns | Description |
|---|---|---|
| `lien.check(agentId)` | `CreditScore` | Compact score (`GET /score`). |
| `lien.report(agentId)` | `Report` | Full report (`GET /report`). |
| `lien.registry(params?)` | `Page<CreditScore>` | Paginated registry. |
| `lien.settlements.create(body, { idempotencyKey })` | `Settlement` | Report an outcome. |
| `lien.attest(agentId, { feedbackAuth })` | `CreditScore` | Write attestation. |
| `Lien.webhooks.constructEvent(body, sig, secret)` | `Event` | Verify + parse a webhook. |

Errors throw a typed `LienError` carrying the HTTP status and error `type`:

```ts
import { Lien, LienError } from "@lien/sdk";

try {
  const credit = await lien.check(agentId);
  if (credit.status === "good_standing") openTab(agentId, credit.limit);
} catch (e) {
  if (e instanceof LienError && e.type === "agent_not_registered") {
    // no 8004 identity and no settlement history — require prepay
  } else {
    throw e;
  }
}
```

---

## Post-paid integration

The provider-side lifecycle:

1. On first access, `lien.check(agentId)`. If `defaulted` (or no `limit`), require
   prepay and stop.
2. Open a tab in your billing system using `limit.amount` / `limit.period`.
3. Meter the agent's usage against the tab.
4. At period end, settle net (one aggregated payment via x402 / your rail).
5. `lien.settlements.create({ agent_id, tab_id, amount, on_time })` so the outcome
   feeds the next score.
6. Subscribe to `agent.defaulted` to close tabs mid-period if standing drops.

```ts
const credit = await lien.check(agentId);
if (!credit.limit) return requirePrepay(agentId);

const tab = billing.openTab(agentId, credit.limit);
// ... usage accrues over the period ...
const result = await billing.settle(tab);            // net settlement

await lien.settlements.create(
  { agent_id: agentId, tab_id: tab.id, amount: result.amount, on_time: result.onTime },
  { idempotencyKey: result.id }
);
```

---

## Scoring model

The score is computed off-chain over a trailing 90-day window from up to two input
sources: the agent's **8004 reputation** (identity age, counterparties, feedback
ratings/tags, ATOM quality/trust) and **LIEN's own settlement ledger** (outcomes you
report via `POST /settlements`). It is deterministic: same inputs, same score.

Which sources apply depends on the agent's [identity](#identity-model):

- **8004 + ledger** — reputation and observed settlements are blended. An 8004 agent
  with no ledger yet is *bootstrapped* from reputation alone (`bootstrapped: true`).
- **Ledger-only (x402 / wallet)** — no 8004 record, so the score comes entirely from
  reported settlements (`bootstrapped: false`); `account_age` is anchored to the
  earliest settlement and reputation factors stay neutral.

| Factor (`key`) | Measures | Weight |
|---|---|---|
| `on_time_rate` | Share of obligations closed on time | 0.30 |
| `volume` | Total settled value in the window | 0.25 |
| `account_age` | Days the identity has been active (8004 age, or first settlement) | 0.15 |
| `counterparty_diversity` | Distinct counterparties | 0.15 |
| `defaults` | Count of unsettled obligations (penalty) | 0.15 |

The weighted result maps to 300–850, bucketed into bands (`poor` <580, `fair`
580–669, `good` 670–739, `very_good` 740–799, `excellent` 800+). The recommended
`limit` scales with both the score and the agent's typical per-period settlement
volume, so a high score on a low-volume agent still yields a conservative ceiling.

---

## Identity model

LIEN's canonical subject is an entry in **LIEN's own registry**, keyed by `agent_id`.
LIEN does not require an agent to live in any single namespace — an `agent_id`
resolves through one or more **identity sources**, and the credit file is the union
of what those sources tell us. This is what lets LIEN score agents far beyond the
~1.5k that have self-registered on-chain.

**Identity sources**

| Source | Provides | `verified_8004` |
|---|---|---|
| **8004 registry** (on Solana) | Identity (name, image, endpoints), reputation/feedback, account age. The `agent_id` is the 8004 account address. | `true` |
| **Payment wallet / x402** | Real settlement behavior — volume, on-time rate, counterparty diversity, defaults. The `agent_id` is the payment wallet address. No 8004 record required. | `false` |

**How a score is built**

- **8004 agent.** LIEN reads the agent's reputation as input and blends it with any
  settlements you've reported. New agents with no ledger yet are *bootstrapped* from
  8004 reputation alone (`bootstrapped: true` on the affected factors).
- **Wallet-only (x402) agent.** With no 8004 record, the score is computed purely
  from the agent's reported settlement ledger (`bootstrapped: false` throughout) —
  see [Scoring model](#scoring-model). A wallet nobody has reported any settlement
  for has no credit file and returns `agent_not_registered`.
- **Both.** When an agent has an 8004 record *and* a reported ledger, a single score
  blends reputation with observed behavior — there is no double-counting.

> **Why LIEN doesn't mint identities.** LIEN never registers agents into 8004 on
> their behalf: an 8004 entry is only meaningful when its owner holds the key, so a
> bureau-created entry would be an unverifiable claim that pollutes a shared
> registry. LIEN observes the identities that already exist (8004 or payment wallet)
> and scores behavior — it doesn't issue the identities it scores.

**Write-back (attestation).** `POST /attest/:agent_id` writes the score back to an
agent's **existing 8004 record** as a signed snapshot, so other 8004-aware services
can read it. It uses 8004's feedback-authorization mechanism: the agent signs an
authorization (EIP-191 for EOAs, ERC-1271 for contract accounts) permitting LIEN to
post, then the score travels with its identity.

The `feedback_auth` body:

```json
{
  "client": "lien.credit",
  "agent_id": "agent:sol:7xKq9b9c4",
  "expiry": "2026-12-31T00:00:00Z",
  "signature": "0x..."
}
```

**Linking & sponsored registration** _(roadmap)_

- **Linking.** A payment wallet and an 8004 account are distinct addresses, so the
  same real agent can hold two separate files until linked. Linking will be
  **explicit and signed** — the agent proves control of the wallet to merge it into
  its 8004 file — never inferred by shared `owner` (one owner can run many agents).
- **Sponsored self-registration.** For agents that *want* an on-chain identity, LIEN
  can subsidize gas and provide one-click 8004 registration that the agent signs with
  its own key (owner = the agent), bootstrapping the ecosystem without minting
  custodial identities.
