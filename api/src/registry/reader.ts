import { GraphQLClient } from "./graphql.js";
import type { RawAgent, RawFeedback } from "./types.js";

const AGENT_FIELDS = `
  id
  agentId
  owner
  totalFeedback
  createdAt
  updatedAt
  solana { assetPubkey qualityScore trustTier }
  registrationFile { name description image active mcpEndpoint a2aEndpoint }
`;

const FEEDBACK_FIELDS = `
  id
  clientAddress
  value
  tag1
  tag2
  endpoint
  isRevoked
  createdAt
  revokedAt
`;

export interface ListAgentsOptions {
  first?: number;
  orderBy?: "totalFeedback" | "createdAt" | "updatedAt";
  orderDirection?: "asc" | "desc";
}

export interface GetFeedbackOptions {
  first?: number;
  includeRevoked?: boolean;
}

/**
 * Read-only view of the 8004 Agent Registry, backed by Quantu's verified indexer.
 * We never read raw event streams — only the indexer GraphQL, per the 8004 spec.
 */
export class RegistryReader {
  constructor(private readonly gql: GraphQLClient) {}

  /** Resolve identity + ATOM signals + registration file for one agent. */
  async resolveAgent(id: string): Promise<RawAgent | null> {
    const data = await this.gql.request<{ agent: RawAgent | null }>(
      `query($id: ID!) { agent(id: $id) { ${AGENT_FIELDS} } }`,
      { id },
    );
    return data.agent ?? null;
  }

  /** All (non-revoked by default) feedback for an agent, newest first. */
  async getFeedback(agentId: string, opts: GetFeedbackOptions = {}): Promise<RawFeedback[]> {
    const first = clampFirst(opts.first ?? 50);
    const data = await this.gql.request<{ feedbacks: RawFeedback[] }>(
      `query($a: ID!, $first: Int!) {
        feedbacks(first: $first, where: { agent: $a }, orderBy: createdAt, orderDirection: desc) {
          ${FEEDBACK_FIELDS}
        }
      }`,
      { a: agentId, first },
    );
    const rows = data.feedbacks ?? [];
    return opts.includeRevoked ? rows : rows.filter((f) => !f.isRevoked);
  }

  /** Enumerate agents for the registry / batch scoring. */
  async listAgents(opts: ListAgentsOptions = {}): Promise<RawAgent[]> {
    const first = clampFirst(opts.first ?? 50);
    const orderBy = opts.orderBy ?? "totalFeedback";
    const orderDirection = opts.orderDirection ?? "desc";
    const data = await this.gql.request<{ agents: RawAgent[] }>(
      `query($first: Int!) {
        agents(first: $first, orderBy: ${orderBy}, orderDirection: ${orderDirection}) {
          ${AGENT_FIELDS}
        }
      }`,
      { first },
    );
    return data.agents ?? [];
  }

  /** Indexer-wide counters — handy for health checks and the spike. */
  async globalStats(): Promise<{ totalAgents: string; totalFeedback: string; totalCollections: string }> {
    const data = await this.gql.request<{
      globalStats: { totalAgents: string; totalFeedback: string; totalCollections: string };
    }>(`{ globalStats { totalAgents totalFeedback totalCollections } }`);
    return data.globalStats;
  }
}

function clampFirst(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(n)));
}
