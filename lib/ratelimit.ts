import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "./kv";
import { withSpan } from "./tracing";

export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** Unix time in milliseconds when the window resets. */
  reset: number;
};

type Policy = { requests: number; windowSeconds: number };

export const POLICIES = {
  /** Creating API keys, per client IP. */
  createKey: { requests: 5, windowSeconds: 60 * 60 },
  /** Creating links, per API key. */
  createLink: { requests: 30, windowSeconds: 60 },
  /** Listing, reading stats and deleting, per API key. */
  manage: { requests: 120, windowSeconds: 60 },
} satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

const upstashLimiters = new Map<PolicyName, Ratelimit>();

function upstashLimiter(name: PolicyName): Ratelimit | null {
  const redis = getRedis();
  if (!redis) return null;
  let limiter = upstashLimiters.get(name);
  if (!limiter) {
    const { requests, windowSeconds } = POLICIES[name];
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(requests, `${windowSeconds} s`),
      prefix: `ratelimit:${name}`,
    });
    upstashLimiters.set(name, limiter);
  }
  return limiter;
}

type Window = { count: number; resetAt: number };

const globalStore = globalThis as typeof globalThis & { __memoryRateLimits?: Map<string, Window> };

/** Fixed-window limiter for local dev and tests, where Upstash isn't configured. */
function memoryLimit(name: PolicyName, identifier: string, now = Date.now()): RateLimitResult {
  globalStore.__memoryRateLimits ??= new Map();
  const windows = globalStore.__memoryRateLimits;
  const { requests, windowSeconds } = POLICIES[name];
  const key = `${name}:${identifier}`;

  let window = windows.get(key);
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + windowSeconds * 1000 };
    windows.set(key, window);
  }
  window.count++;

  return {
    success: window.count <= requests,
    limit: requests,
    remaining: Math.max(0, requests - window.count),
    reset: window.resetAt,
  };
}

export function resetMemoryRateLimits(): void {
  delete globalStore.__memoryRateLimits;
}

/**
 * Applies a rate limit policy to `identifier`, in a `ratelimit <policy>` span. The span
 * records the policy and outcome, not the identifier, which is a client IP or key ID.
 */
export function rateLimit(name: PolicyName, identifier: string): Promise<RateLimitResult> {
  const limiter = upstashLimiter(name);
  return withSpan(
    `ratelimit ${name}`,
    { "app.ratelimit.policy": name, "app.ratelimit.store": limiter ? "upstash" : "memory" },
    async (span) => {
      let result: RateLimitResult;
      if (limiter) {
        const { success, limit, remaining, reset } = await limiter.limit(identifier);
        result = { success, limit, remaining, reset };
      } else {
        result = memoryLimit(name, identifier);
      }
      span.setAttributes({
        "app.ratelimit.success": result.success,
        "app.ratelimit.limit": result.limit,
        "app.ratelimit.remaining": result.remaining,
      });
      return result;
    },
  );
}
