import { createHash, randomBytes } from "node:crypto";
import { getKV } from "./kv";

export type ApiKeyRecord = { id: string; name: string; createdAt: string };

const KEY_PREFIX = "sk_";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const recordKey = (hash: string) => `apikey:${hash}`;

/** Creates a key. The plaintext key is returned once; only its hash is stored. */
export async function createApiKey(name: string): Promise<{ key: string; record: ApiKeyRecord }> {
  const key = KEY_PREFIX + randomBytes(24).toString("base64url");
  const record: ApiKeyRecord = {
    id: "key_" + randomBytes(8).toString("hex"),
    name,
    createdAt: new Date().toISOString(),
  };
  await getKV().set(recordKey(hashKey(key)), record);
  return { key, record };
}

export async function verifyApiKey(key: string): Promise<ApiKeyRecord | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  return getKV().get<ApiKeyRecord>(recordKey(hashKey(key)));
}

/** Reads the key from `Authorization: Bearer <key>` or `X-API-Key: <key>`. */
export function apiKeyFromRequest(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;
  return request.headers.get("x-api-key")?.trim() || null;
}
