import type { RateLimitResult } from "./ratelimit";

export type ErrorCode =
  "bad_request" | "unauthorized" | "not_found" | "conflict" | "rate_limited" | "internal_error";

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  headers?: HeadersInit,
): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.reset / 1000)),
  };
}

export function rateLimitedResponse(result: RateLimitResult): Response {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return errorResponse(429, "rate_limited", "Too many requests. Try again later.", {
    ...rateLimitHeaders(result),
    "Retry-After": String(retryAfter),
  });
}

/** Best-effort client IP. On Vercel, x-forwarded-for is set by the platform. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

/** Parses a JSON body, returning undefined if it is missing or malformed. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}
