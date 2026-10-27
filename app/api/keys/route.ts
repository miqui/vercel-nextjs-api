import { z } from "zod";
import { createApiKey } from "@/lib/api-keys";
import { clientIp, errorResponse, rateLimitedResponse, rateLimitHeaders, readJson } from "@/lib/http";
import { rateLimit } from "@/lib/ratelimit";

const CreateKeyBody = z
  .object({ name: z.string().trim().min(1).max(64) })
  .partial()
  .optional();

/** Issues a new API key. Rate limited per client IP. */
export async function POST(request: Request) {
  const limit = await rateLimit("createKey", clientIp(request));
  if (!limit.success) return rateLimitedResponse(limit);

  const parsed = CreateKeyBody.safeParse(await readJson(request));
  if (!parsed.success) {
    return errorResponse(400, "bad_request", z.prettifyError(parsed.error), rateLimitHeaders(limit));
  }

  const { key, record } = await createApiKey(parsed.data?.name ?? "default");
  return Response.json(
    { key, ...record, note: "Store this key now. It cannot be shown again." },
    { status: 201, headers: rateLimitHeaders(limit) },
  );
}
