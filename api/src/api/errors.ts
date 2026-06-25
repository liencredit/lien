import type { FastifyReply } from "fastify";

export type ErrorType =
  | "invalid_request"
  | "authentication_error"
  | "authorization_required"
  | "not_found"
  | "agent_not_registered"
  | "idempotency_conflict"
  | "rate_limited"
  | "api_error";

const STATUS: Record<ErrorType, number> = {
  invalid_request: 400,
  authentication_error: 401,
  authorization_required: 403,
  not_found: 404,
  agent_not_registered: 404,
  idempotency_conflict: 409,
  rate_limited: 429,
  api_error: 500,
};

export function sendError(
  reply: FastifyReply,
  type: ErrorType,
  message: string,
  param?: string,
) {
  return reply.code(STATUS[type]).send({ error: { type, message, ...(param ? { param } : {}) } });
}
