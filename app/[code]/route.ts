import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/http";
import { CODE_PATTERN, getLink, recordClick } from "@/lib/links";

/** Redirects a short code to its URL and counts the click. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/[code]">) {
  const { code } = await ctx.params;
  const link = CODE_PATTERN.test(code) ? await getLink(code) : null;
  if (!link) return errorResponse(404, "not_found", "Link not found.");

  await recordClick(code);
  // 307 rather than 301/308: browsers cache permanent redirects, which would skip click counting.
  return new Response(null, {
    status: 307,
    headers: { Location: link.url, "Cache-Control": "no-store" },
  });
}
