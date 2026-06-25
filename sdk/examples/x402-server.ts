/**
 * x402 + LIEN reference integration.
 *
 * A resource server that meters paid access by AI agents. It asks LIEN whether the
 * calling agent is creditworthy and, if so, extends a post-paid tab — and every
 * payment (prepaid OR post-paid) is reported back to LIEN so the agent's score
 * reflects real behavior. This closes the cold-start loop: a brand-new wallet
 * prepays at first (vanilla x402), those prepayments build its LIEN file, and once
 * it has enough history it graduates to post-paid credit — no prepay required.
 *
 *   request → LIEN.authorize(payer)
 *     creditworthy → serve on a tab          → reportPayment(post-paid)
 *     not yet      → require payment (402)
 *       w/ payment → serve + reportPayment(prepaid)  ← builds the credit file
 *
 * The agent identifies itself by its payment wallet (the `X-Agent-Wallet` header
 * here; in production, recovered from the signed x402 `X-PAYMENT` payload). No 8004
 * registration is required — the wallet IS the identity.
 *
 * Run the API first (cd ../../api && npm run dev), then: `npx tsx examples/x402-server.ts`.
 * Cold-start (prepay builds history):
 *   curl -H "X-Agent-Wallet: w1" -H "X-PAYMENT: paid" http://127.0.0.1:4021/premium-data
 * After enough history, it serves on credit with no payment header.
 */
import { createServer } from "node:http";
import { Lien, LienError } from "../src/index.js";

const BASE_URL = process.env.LIEN_BASE_URL ?? "http://127.0.0.1:8787/v1";
const API_KEY = process.env.LIEN_API_KEY ?? "sk_test_demo";
const PRICE = 250_000; // 0.25 USDC per call, minor units
const RESOURCE = "data.premium-oracle.xyz"; // this server's identity as a counterparty

const lien = new Lien({ apiKey: API_KEY, baseUrl: BASE_URL });

const server = createServer(async (req, res) => {
  const payer = req.headers["x-agent-wallet"];
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  };

  if (typeof payer !== "string" || !payer) {
    return send(400, { error: "missing X-Agent-Wallet header" });
  }

  // In production this proves an x402 payment (signed X-PAYMENT payload, verified
  // + settled by the facilitator). Here, any X-PAYMENT header simulates prepayment.
  const prepaid = typeof req.headers["x-payment"] === "string";

  try {
    // 1. Ask LIEN whether to extend credit to this agent.
    const auth = await lien.x402.authorize(payer);

    if (!auth.creditworthy && !prepaid) {
      // 2a. No credit yet and no payment → require prepay (HTTP 402 Payment Required).
      return send(402, {
        error: "payment_required",
        reason: auth.score ? "insufficient_standing" : "no_credit_file",
        amount: PRICE,
        currency: "USDC",
        resource: RESOURCE,
        message: "Prepay (resend with X-PAYMENT). Prepayments build your LIEN credit file.",
      });
    }

    // 2b. Either creditworthy (post-paid tab) or prepaid → serve the resource.
    const mode = auth.creditworthy ? "post-paid" : "prepaid";
    const payload = { resource: RESOURCE, data: { price: 42_000, ts: Date.now() }, served_to: payer };

    // 3. Report the payment to LIEN — both modes feed the agent's score.
    const settlement = await lien.x402.reportPayment({
      payer,
      amount: PRICE,
      resource: RESOURCE,
      onTime: true,
    });

    return send(200, {
      ...payload,
      lien: { mode, settlement_id: settlement.id, limit: auth.limit, score: auth.score?.score },
    });
  } catch (e) {
    if (e instanceof LienError) return send(502, { error: "lien_error", type: e.type, message: e.message });
    return send(500, { error: "internal", message: (e as Error).message });
  }
});

const PORT = Number(process.env.PORT ?? 4021);
server.listen(PORT, () => {
  console.log(`x402 resource server on http://127.0.0.1:${PORT} (LIEN: ${BASE_URL})`);
  console.log(`try: curl -H "X-Agent-Wallet: <wallet>" http://127.0.0.1:${PORT}/premium-data`);
});
