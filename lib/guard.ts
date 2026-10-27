import { apiKeyFromRequest, verifyApiKey, type ApiKeyRecord } from "./api-keys";
import { errorResponse, rateLimitedResponse, rateLimitHeaders } from "./http";
import { rateLimit, type PolicyName } from "./ratelimit";

type Guarded =
  { ok: true; apiKey: ApiKeyRecord; headers: Record<string, string> } | { ok: false; response: Response };

/** Authenticates the request's API key, then applies the rate limit policy to that key. */
export async function requireApiKey(request: Request, policy: PolicyName): Promise<Guarded> {
  const key = apiKeyFromRequest(request);
  if (!key) {
    return {
      ok: false,
      response: errorResponse(401, "unauthorized", "Missing API key. Send `Authorization: Bearer <key>`."),
    };
  }

  const apiKey = await verifyApiKey(key);
  if (!apiKey) {
    return { ok: false, response: errorResponse(401, "unauthorized", "Invalid API key.") };
  }

  const limit = await rateLimit(policy, apiKey.id);
  if (!limit.success) return { ok: false, response: rateLimitedResponse(limit) };

  return { ok: true, apiKey, headers: rateLimitHeaders(limit) };
}
