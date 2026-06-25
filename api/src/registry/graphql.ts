export interface GraphQLClientOptions {
  url: string;
  timeoutMs?: number;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

export class GraphQLError extends Error {
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = "GraphQLError";
  }
}

/**
 * Minimal GraphQL-over-HTTP client for the 8004 indexer. No external deps:
 * the indexer speaks plain POST JSON. Reads only — we never mutate 8004 here.
 */
export class GraphQLClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(opts: GraphQLClientOptions) {
    this.url = opts.url;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new GraphQLError(
          `8004 indexer returned HTTP ${res.status}`,
          await res.text().catch(() => undefined),
        );
      }

      const body = (await res.json()) as GraphQLResponse<T>;
      if (body.errors?.length) {
        throw new GraphQLError(body.errors.map((e) => e.message).join("; "), body.errors);
      }
      if (body.data === undefined) {
        throw new GraphQLError("8004 indexer returned no data");
      }
      return body.data;
    } catch (err) {
      if (err instanceof GraphQLError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new GraphQLError(`8004 indexer request timed out after ${this.timeoutMs}ms`);
      }
      throw new GraphQLError("8004 indexer request failed", err);
    } finally {
      clearTimeout(timer);
    }
  }
}
