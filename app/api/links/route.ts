import { z } from "zod";
import { requireApiKey } from "@/lib/guard";
import { errorResponse, readJson } from "@/lib/http";
import { CODE_PATTERN, CodeTakenError, createLink, isReservedCode, listLinks } from "@/lib/links";

const CreateLinkBody = z.object({
  url: z.httpUrl().max(2048),
  code: z
    .string()
    .regex(CODE_PATTERN, "Code must be 3-32 characters: letters, digits, '-' or '_'.")
    .refine((code) => !isReservedCode(code), "This code is reserved.")
    .optional(),
});

function shortUrl(request: Request, code: string): string {
  return new URL(`/${code}`, request.url).toString();
}

/** Lists the links owned by the calling API key. */
export async function GET(request: Request) {
  const guard = await requireApiKey(request, "manage");
  if (!guard.ok) return guard.response;

  const links = await listLinks(guard.apiKey.id);
  return Response.json(
    { links: links.map((link) => ({ ...link, shortUrl: shortUrl(request, link.code) })) },
    { headers: guard.headers },
  );
}

/** Creates a short link, optionally with a custom code. */
export async function POST(request: Request) {
  const guard = await requireApiKey(request, "createLink");
  if (!guard.ok) return guard.response;

  const parsed = CreateLinkBody.safeParse(await readJson(request));
  if (!parsed.success) {
    return errorResponse(400, "bad_request", z.prettifyError(parsed.error), guard.headers);
  }

  // Pointing a short link at this service would allow redirect loops.
  if (new URL(parsed.data.url).host === new URL(request.url).host) {
    return errorResponse(400, "bad_request", "Cannot shorten a URL on this domain.", guard.headers);
  }

  try {
    const link = await createLink({
      url: parsed.data.url,
      ownerId: guard.apiKey.id,
      customCode: parsed.data.code,
    });
    return Response.json(
      { ...link, clicks: 0, shortUrl: shortUrl(request, link.code) },
      { status: 201, headers: guard.headers },
    );
  } catch (error) {
    if (error instanceof CodeTakenError) {
      return errorResponse(409, "conflict", error.message, guard.headers);
    }
    throw error;
  }
}
