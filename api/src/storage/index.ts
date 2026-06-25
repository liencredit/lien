import { MemoryStore } from "./memory.js";
import { PostgresStore } from "./postgres.js";
import { SupabaseStore } from "./supabase.js";
import type { Store } from "./types.js";

export * from "./types.js";
export { MemoryStore } from "./memory.js";
export { PostgresStore } from "./postgres.js";
export { SupabaseStore } from "./supabase.js";

export interface CreateStoreOptions {
  databaseUrl?: string | null;
  supabase?: { url: string; serviceKey: string } | null;
}

export interface CreateStoreResult {
  store: Store;
  backend: "postgres" | "supabase" | "in-memory";
}

/**
 * Resolve the active Store. Preference order: Postgres (durable) → Supabase →
 * in-memory (dev/demo). All satisfy the same `Store` contract. Async because the
 * Postgres backend creates its schema on first use.
 */
export async function createStore(opts: CreateStoreOptions = {}): Promise<CreateStoreResult> {
  if (opts.databaseUrl) {
    const store = new PostgresStore(opts.databaseUrl);
    await store.init();
    return { store, backend: "postgres" };
  }
  if (opts.supabase) {
    return { store: new SupabaseStore(opts.supabase), backend: "supabase" };
  }
  return { store: new MemoryStore(), backend: "in-memory" };
}
