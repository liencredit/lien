// Shapes verified against the live 8004 indexer GraphQL schema (introspection,
// 2026-06). Timestamps (`createdAt`, `revokedAt`) are unix-seconds as BigInt
// strings. `value` is a decimal rating string. `qualityScore` is 0–10000 and
// `trustTier` is 0–4 (Unrated, Bronze, Silver, Gold, Platinum).

export interface AgentSolanaExtension {
  assetPubkey: string;
  qualityScore: number;
  trustTier: number;
}

export interface AgentRegistrationFile {
  name: string | null;
  description: string | null;
  image: string | null;
  active: boolean | null;
  mcpEndpoint: string | null;
  a2aEndpoint: string | null;
}

export interface RawAgent {
  id: string;
  agentId: string;
  owner: string;
  totalFeedback: string;
  createdAt: string;
  updatedAt: string;
  solana: AgentSolanaExtension | null;
  registrationFile: AgentRegistrationFile | null;
}

export interface RawFeedback {
  id: string;
  clientAddress: string;
  value: string;
  tag1: string | null;
  tag2: string | null;
  endpoint: string | null;
  isRevoked: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export const TRUST_TIER_NAMES = [
  "Unrated",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
] as const;

export type TrustTierName = (typeof TRUST_TIER_NAMES)[number];

export function trustTierName(tier: number): TrustTierName {
  return TRUST_TIER_NAMES[tier] ?? "Unrated";
}
