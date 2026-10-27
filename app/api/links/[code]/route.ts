import type { NextRequest } from "next/server";
import { requireApiKey } from "@/lib/guard";
import { errorResponse } from "@/lib/http";
import { deleteLink, getLinkWithStats } from "@/lib/links";

/** Returns a link and its click count. Only the owning API key can see it. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/links/[code]">) {
  const guard = await requireApiKey(request, "manage");
  if (!guard.ok) return guard.response;

  const { code } = await ctx.params;
  const link = await getLinkWithStats(code);
  // Report other owners' links as missing, so codes can't be probed for ownership.
  if (!link || link.ownerId !== guard.apiKey.id) {
    return errorResponse(404, "not_found", "Link not found.", guard.headers);
  }

  return Response.json(
    { ...link, shortUrl: new URL(`/${link.code}`, request.url).toString() },
    { headers: guard.headers },
  );
}

/** Deletes a link owned by the calling API key. */
export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/links/[code]">) {
  const guard = await requireApiKey(request, "manage");
  if (!guard.ok) return guard.response;

  const { code } = await ctx.params;
  const link = await getLinkWithStats(code);
  if (!link || link.ownerId !== guard.apiKey.id) {
    return errorResponse(404, "not_found", "Link not found.", guard.headers);
  }

  await deleteLink(link);
  return new Response(null, { status: 204, headers: guard.headers });
}
