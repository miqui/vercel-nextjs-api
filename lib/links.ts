import { customAlphabet } from "nanoid";
import { getKV } from "./kv";

export type Link = { code: string; url: string; ownerId: string; createdAt: string };
export type LinkWithStats = Link & { clicks: number };

export const CODE_PATTERN = /^[A-Za-z0-9_-]{3,32}$/;

/** Codes that would shadow app routes or common root files. */
const RESERVED_CODES = new Set(["api", "favicon.ico", "robots.txt", "sitemap.xml", "_next"]);

const generateCode = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ", 7);

const linkKey = (code: string) => `link:${code}`;
const clicksKey = (code: string) => `clicks:${code}`;
const ownerLinksKey = (ownerId: string) => `owner:${ownerId}:links`;

export function isReservedCode(code: string): boolean {
  return RESERVED_CODES.has(code.toLowerCase());
}

export class CodeTakenError extends Error {
  constructor(code: string) {
    super(`The code "${code}" is already taken.`);
  }
}

/** Stores a link under `customCode`, or a generated code. Throws CodeTakenError on a custom-code clash. */
export async function createLink(input: {
  url: string;
  ownerId: string;
  customCode?: string;
}): Promise<Link> {
  const kv = getKV();
  const createdAt = new Date().toISOString();
  // A generated code can collide; retry a few times before giving up.
  const attempts = input.customCode ? 1 : 5;

  for (let i = 0; i < attempts; i++) {
    const code = input.customCode ?? generateCode();
    const link: Link = { code, url: input.url, ownerId: input.ownerId, createdAt };
    if (await kv.set(linkKey(code), link, { nx: true })) {
      await kv.sadd(ownerLinksKey(input.ownerId), code);
      return link;
    }
    if (input.customCode) throw new CodeTakenError(code);
  }
  throw new Error("Could not generate a unique code.");
}

export function getLink(code: string): Promise<Link | null> {
  return getKV().get<Link>(linkKey(code));
}

export async function getLinkWithStats(code: string): Promise<LinkWithStats | null> {
  const kv = getKV();
  const [link, clicks] = await Promise.all([kv.get<Link>(linkKey(code)), kv.get<number>(clicksKey(code))]);
  return link ? { ...link, clicks: Number(clicks ?? 0) } : null;
}

export async function listLinks(ownerId: string): Promise<LinkWithStats[]> {
  const kv = getKV();
  const codes = await kv.smembers(ownerLinksKey(ownerId));
  const [links, clicks] = await Promise.all([
    kv.mget<Link>(codes.map(linkKey)),
    kv.mget<number>(codes.map(clicksKey)),
  ]);
  return links
    .map((link, i) => (link ? { ...link, clicks: Number(clicks[i] ?? 0) } : null))
    .filter((link): link is LinkWithStats => link !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteLink(link: Link): Promise<void> {
  const kv = getKV();
  await kv.del([linkKey(link.code), clicksKey(link.code)]);
  await kv.srem(ownerLinksKey(link.ownerId), link.code);
}

export function recordClick(code: string): Promise<number> {
  return getKV().incr(clicksKey(code));
}
