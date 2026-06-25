# @lien/sdk

Thin TypeScript wrapper over the LIEN credit API (`../LIEN-docs.md`). Server-side
only — your API key is secret.

## Install

```bash
npm install @lien/sdk
```

## Usage

```ts
import { Lien, LienError } from "@lien/sdk";

const lien = new Lien({
  apiKey: process.env.LIEN_API_KEY!, // sk_live_* or sk_test_*
  network: "mainnet",                // or "devnet"
  // baseUrl: "http://127.0.0.1:8787/v1", // local dev override
});

const credit = await lien.check("agent:sol:7xKq9b9c4");
if (credit.status === "good_standing" && credit.limit) {
  // open a tab using credit.limit.amount / credit.limit.period
}
```

| Method | Returns |
|---|---|
| `lien.check(agentId)` | `CreditScore` |
| `lien.report(agentId)` | `Report` |
| `lien.registry(params?)` | `Page<CreditScore>` |
| `lien.settlements.create(body, { idempotencyKey })` | `Settlement` |
| `lien.attest(agentId, { feedbackAuth })` | `CreditScore` |
| `Lien.webhooks.constructEvent(rawBody, sig, secret)` | `WebhookEvent` |

Errors throw a typed `LienError` with `.status`, `.type`, and `.retryable`.

## Demo

The post-paid loop end-to-end (check → tab → meter → settle → re-score):

```bash
cd ../api && npm install && npm run dev   # terminal 1
cd ../sdk && npm install && npm run demo   # terminal 2
```

## Scripts

| Command | What |
|---|---|
| `npm run build` | Compile to `dist/`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | SDK unit tests. |
| `npm run demo` | Run the post-paid demo against a local API. |
