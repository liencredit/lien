import type { ScoreRecord } from "../storage/types.js";

export interface FeedbackAuth {
  client: string;
  agent_id: string;
  expiry: string;
  signature: string;
}

export interface AttestationResult {
  /** Whether the score was actually written to an external record. */
  written: boolean;
  /** How/where it was written. */
  mode: "noop" | "onchain" | "8004";
  /** Tx signature / event id when written. */
  ref?: string;
}

export interface AttestationWriter {
  write(score: ScoreRecord, auth: FeedbackAuth): Promise<AttestationResult>;
}

/**
 * Default writer: performs no external write. Attestation is acknowledged but the
 * score is NOT written on-chain / to 8004 until a real signer is configured. This
 * keeps `attested` honest (stays false) instead of faking an on-chain write.
 */
export class NoopAttestationWriter implements AttestationWriter {
  async write(): Promise<AttestationResult> {
    return { written: false, mode: "noop" };
  }
}

/**
 * Resolve the active writer. When the 8004 signer + LIEN score program are
 * configured (LIEN_SIGNER_SECRET, LIEN_SCORE_PROGRAM_ID), return a real writer
 * that posts 8004 feedback (pre-auth) and/or writes the on-chain PDA. Until then,
 * the noop writer is used. Wiring the real writer is the remaining work for step 7.
 */
export function createAttestationWriter(): AttestationWriter {
  // const signer = process.env.LIEN_SIGNER_SECRET;
  // const programId = process.env.LIEN_SCORE_PROGRAM_ID;
  // if (signer && programId) return new OnchainAttestationWriter(signer, programId);
  return new NoopAttestationWriter();
}

export type AuthValidation =
  | { ok: true }
  | { ok: false; reason: string; param?: string };

/** Validate a feedback authorization against the target agent and clock. */
export function validateFeedbackAuth(
  auth: unknown,
  agentId: string,
  now = Date.now(),
): AuthValidation {
  if (typeof auth !== "object" || auth === null) {
    return { ok: false, reason: "feedback_auth is required", param: "feedback_auth" };
  }
  const a = auth as Record<string, unknown>;

  for (const field of ["client", "agent_id", "expiry", "signature"] as const) {
    if (typeof a[field] !== "string" || (a[field] as string).length === 0) {
      return { ok: false, reason: `feedback_auth.${field} is required`, param: `feedback_auth.${field}` };
    }
  }

  if (a.agent_id !== agentId) {
    return { ok: false, reason: "feedback_auth.agent_id does not match the path agent", param: "feedback_auth.agent_id" };
  }

  const expiry = Date.parse(a.expiry as string);
  if (Number.isNaN(expiry)) {
    return { ok: false, reason: "feedback_auth.expiry is not a valid timestamp", param: "feedback_auth.expiry" };
  }
  if (expiry <= now) {
    return { ok: false, reason: "feedback_auth has expired", param: "feedback_auth.expiry" };
  }

  return { ok: true };
}
