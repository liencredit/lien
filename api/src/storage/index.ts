import { MemoryStore } from "./memory.js";
import { SupabaseStore } from "./supabase.js";
import type { Store } from "./types.js";

export * from "./types.js";
export { MemoryStore } from "./memory.js";
export { SupabaseStore } from "./supabase.js";

export interface CreateStoreOptions {
  supabase?: { url: string; serviceKey: string } | null;
}

/**
 * Resolve the active Store: Supabase-backed when credentials are provided,
 * otherwise in-memory (dev/demo). Both satisfy the same `Store` contract.
 */
export function createStore(opts: CreateStoreOptions = {}): Store {
  if (opts.supabase) {
    return new SupabaseStore(opts.supabase);
  }
  return new MemoryStore();
}
