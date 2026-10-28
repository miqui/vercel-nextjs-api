import { Redis } from "@upstash/redis";
import { withSpan } from "./tracing";

/** The subset of Redis commands the app uses, so storage can be swapped in tests and local dev. */
export interface KV {
  get<T>(key: string): Promise<T | null>;
  mget<T>(keys: string[]): Promise<(T | null)[]>;
  /** Returns true if the value was written (always, unless `nx` is set and the key exists). */
  set(key: string, value: unknown, opts?: { nx?: boolean }): Promise<boolean>;
  del(keys: string[]): Promise<number>;
  incr(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

export function redisCredentials(): { url: string; token: string } | null {
  // Vercel's Upstash integration may set either naming scheme. `||` so empty values fall through.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

let redis: Redis | undefined;

export function getRedis(): Redis | null {
  const creds = redisCredentials();
  if (!creds) return null;
  redis ??= new Redis(creds);
  return redis;
}

function upstashKV(client: Redis): KV {
  return {
    get: (key) => client.get(key),
    mget: async <T>(keys: string[]) => (keys.length ? client.mget<(T | null)[]>(...keys) : []),
    set: async (key, value, opts) =>
      (await (opts?.nx ? client.set(key, value, { nx: true }) : client.set(key, value))) === "OK",
    del: (keys) => (keys.length ? client.del(...keys) : Promise.resolve(0)),
    incr: (key) => client.incr(key),
    sadd: (key, member) => client.sadd(key, member),
    srem: (key, member) => client.srem(key, member),
    smembers: (key) => client.smembers(key),
  };
}

type MemoryState = { values: Map<string, unknown>; sets: Map<string, Set<string>> };

// Kept on globalThis so data survives hot reloads in `next dev`.
const globalStore = globalThis as typeof globalThis & { __memoryKV?: MemoryState };

function memoryState(): MemoryState {
  globalStore.__memoryKV ??= { values: new Map(), sets: new Map() };
  return globalStore.__memoryKV;
}

export function memoryKV(): KV {
  const { values, sets } = memoryState();
  // Round-trip through JSON so callers can't mutate stored objects, matching Redis semantics.
  const read = <T>(key: string): T | null =>
    values.has(key) ? (JSON.parse(JSON.stringify(values.get(key))) as T) : null;

  return {
    get: async (key) => read(key),
    mget: async (keys) => keys.map((key) => read(key)),
    set: async (key, value, opts) => {
      if (opts?.nx && values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    del: async (keys) => {
      let removed = 0;
      for (const key of keys) {
        if (values.delete(key) || sets.delete(key)) removed++;
      }
      return removed;
    },
    incr: async (key) => {
      const next = Number(values.get(key) ?? 0) + 1;
      values.set(key, next);
      return next;
    },
    sadd: async (key, member) => {
      const set = sets.get(key) ?? new Set<string>();
      sets.set(key, set);
      if (set.has(member)) return 0;
      set.add(member);
      return 1;
    },
    srem: async (key, member) => (sets.get(key)?.delete(member) ? 1 : 0),
    smembers: async (key) => [...(sets.get(key) ?? [])],
  };
}

export function resetMemoryKV(): void {
  delete globalStore.__memoryKV;
}

type Store = "upstash" | "memory";

/** `link:abc` -> `link`. Spans record key prefixes, not keys, which embed codes and key hashes. */
function keyPrefix(key: string | undefined): string {
  return key?.split(":")[0] ?? "";
}

/** Wraps every KV command in a `redis <COMMAND>` span. */
export function tracedKV(kv: KV, store: Store): KV {
  const span = <T>(operation: string, keys: string[], run: () => Promise<T>) =>
    withSpan(
      `redis ${operation}`,
      {
        "db.system.name": "redis",
        "db.operation.name": operation,
        "db.operation.batch.size": keys.length,
        "app.kv.key_prefix": keyPrefix(keys[0]),
        "app.kv.store": store,
      },
      run,
    );

  return {
    get: (key) => span("GET", [key], () => kv.get(key)),
    mget: (keys) => span("MGET", keys, () => kv.mget(keys)),
    set: (key, value, opts) => span("SET", [key], () => kv.set(key, value, opts)),
    del: (keys) => span("DEL", keys, () => kv.del(keys)),
    incr: (key) => span("INCR", [key], () => kv.incr(key)),
    sadd: (key, member) => span("SADD", [key], () => kv.sadd(key, member)),
    srem: (key, member) => span("SREM", [key], () => kv.srem(key, member)),
    smembers: (key) => span("SMEMBERS", [key], () => kv.smembers(key)),
  };
}

/** Upstash Redis when configured; an in-memory store for local dev and tests. Both are traced. */
export function getKV(): KV {
  const client = getRedis();
  if (client) return tracedKV(upstashKV(client), "upstash");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Redis is not configured: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN).",
    );
  }
  return tracedKV(memoryKV(), "memory");
}
