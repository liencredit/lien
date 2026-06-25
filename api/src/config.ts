export type Cluster = "devnet" | "mainnet";

const DEFAULT_GRAPHQL: Record<Cluster, string> = {
  devnet: "https://8004-indexer-dev.qnt.sh/v2/graphql",
  mainnet: "https://8004-indexer-main.qnt.sh/v2/graphql",
};

function readCluster(): Cluster {
  const raw = (process.env.LIEN_CLUSTER ?? "devnet").toLowerCase();
  if (raw === "mainnet" || raw === "mainnet-beta") return "mainnet";
  return "devnet";
}

export interface Config {
  cluster: Cluster;
  graphqlUrl: string;
  port: number;
  host: string;
  /** Load synthetic demo agents into the store on boot. */
  seed: boolean;
  /** If set, require `Authorization: Bearer <key>`. Unset → open (dev only). */
  apiKey: string | null;
  /** Webhook subscribers (url + signing secret). Empty → webhooks disabled. */
  webhooks: Array<{ url: string; secret: string }>;
  /** Postgres connection string. When set, the Store is Postgres-backed (durable). */
  databaseUrl: string | null;
  /** Supabase storage. When both set, the Store is Supabase-backed; else in-memory. */
  supabase: { url: string; serviceKey: string } | null;
  /** Max requests per IP per minute. 0 disables rate limiting. */
  rateLimitPerMin: number;
  /** On boot, score the top-N real 8004 agents into the store. 0 disables. */
  seedRealCount: number;
}

/**
 * Parse webhook subscribers from env. Either a single `LIEN_WEBHOOK_URL` +
 * `LIEN_WEBHOOK_SECRET`, or `LIEN_WEBHOOKS` as JSON: [{"url","secret"}, ...].
 */
function readWebhooks(): Array<{ url: string; secret: string }> {
  const json = process.env.LIEN_WEBHOOKS;
  if (json) {
    try {
      const parsed = JSON.parse(json) as Array<{ url: string; secret: string }>;
      return parsed.filter((s) => s && s.url && s.secret);
    } catch {
      return [];
    }
  }
  const url = process.env.LIEN_WEBHOOK_URL;
  const secret = process.env.LIEN_WEBHOOK_SECRET;
  return url && secret ? [{ url, secret }] : [];
}

function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function loadConfig(): Config {
  const cluster = readCluster();
  const graphqlUrl =
    cluster === "mainnet"
      ? process.env.EIGHT004_GRAPHQL_MAINNET ?? DEFAULT_GRAPHQL.mainnet
      : process.env.EIGHT004_GRAPHQL_DEVNET ?? DEFAULT_GRAPHQL.devnet;

  return {
    cluster,
    graphqlUrl,
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "0.0.0.0",
    seed: readBool(process.env.LIEN_SEED, true),
    apiKey: process.env.LIEN_API_KEY ?? null,
    webhooks: readWebhooks(),
    databaseUrl: process.env.DATABASE_URL ?? null,
    supabase: readSupabase(),
    rateLimitPerMin: Number(process.env.LIEN_RATE_LIMIT ?? 120),
    seedRealCount: Number(process.env.LIEN_SEED_REAL ?? 0),
  };
}

function readSupabase(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceKey ? { url, serviceKey } : null;
}
