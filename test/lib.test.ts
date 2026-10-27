import { afterEach, describe, expect, it, vi } from "vitest";
import { apiKeyFromRequest } from "@/lib/api-keys";
import { clientIp } from "@/lib/http";
import { memoryKV } from "@/lib/kv";
import { CodeTakenError, createLink } from "@/lib/links";
import { rateLimit } from "@/lib/ratelimit";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.resetModules();
  vi.doUnmock("@upstash/redis");
  vi.doUnmock("@upstash/ratelimit");
});

describe("clientIp", () => {
  it("uses the first x-forwarded-for entry, then x-real-ip", () => {
    expect(clientIp(new Request("http://x", { headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" } }))).toBe(
      "1.1.1.1",
    );
    expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "3.3.3.3" } }))).toBe("3.3.3.3");
    expect(clientIp(new Request("http://x"))).toBe("unknown");
  });
});

describe("apiKeyFromRequest", () => {
  it("reads bearer tokens case-insensitively and ignores other schemes", () => {
    expect(apiKeyFromRequest(new Request("http://x", { headers: { authorization: "bearer sk_a" } }))).toBe(
      "sk_a",
    );
    expect(
      apiKeyFromRequest(new Request("http://x", { headers: { authorization: "Basic abc" } })),
    ).toBeNull();
    expect(apiKeyFromRequest(new Request("http://x", { headers: { authorization: "Bearer " } }))).toBeNull();
  });
});

describe("memoryKV", () => {
  it("returns copies, so stored values can't be mutated", async () => {
    const kv = memoryKV();
    await kv.set("k", { n: 1 });
    const value = await kv.get<{ n: number }>("k");
    value!.n = 2;
    expect(await kv.get("k")).toEqual({ n: 1 });
  });

  it("honours nx and reports set membership changes", async () => {
    const kv = memoryKV();
    expect(await kv.set("k", 1, { nx: true })).toBe(true);
    expect(await kv.set("k", 2, { nx: true })).toBe(false);
    expect(await kv.sadd("s", "a")).toBe(1);
    expect(await kv.sadd("s", "a")).toBe(0);
    expect(await kv.srem("s", "a")).toBe(1);
    expect(await kv.srem("missing", "a")).toBe(0);
    expect(await kv.del(["k", "s", "missing"])).toBe(2);
  });
});

describe("createLink", () => {
  it("throws CodeTakenError for a taken custom code", async () => {
    await createLink({ url: "https://a.com", ownerId: "o", customCode: "taken" });
    await expect(
      createLink({ url: "https://b.com", ownerId: "o", customCode: "taken" }),
    ).rejects.toBeInstanceOf(CodeTakenError);
  });

  it("gives up after repeated collisions on generated codes", async () => {
    vi.doMock("nanoid", () => ({ customAlphabet: () => () => "samecode" }));
    vi.resetModules();
    const links = await import("@/lib/links");
    await links.createLink({ url: "https://a.com", ownerId: "o" });
    await expect(links.createLink({ url: "https://b.com", ownerId: "o" })).rejects.toThrow(/unique code/);
    vi.doUnmock("nanoid");
  });
});

describe("rateLimit (in memory)", () => {
  it("resets after the window passes", async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) await rateLimit("createKey", "ip");
    expect((await rateLimit("createKey", "ip")).success).toBe(false);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect((await rateLimit("createKey", "ip")).success).toBe(true);
  });
});

describe("with Upstash configured", () => {
  function stubCredentials(prefix: "UPSTASH_REDIS_REST" | "KV_REST_API") {
    vi.stubEnv(`${prefix}_URL`, "https://example.upstash.io");
    vi.stubEnv(`${prefix}_TOKEN`, "token");
  }

  it("adapts the Upstash client to the KV interface", async () => {
    stubCredentials("KV_REST_API");
    const fake = memoryKV();
    const constructed = vi.fn();
    vi.doMock("@upstash/redis", () => ({
      Redis: class {
        constructor(opts: unknown) {
          constructed(opts);
        }
        get = fake.get;
        mget = (...keys: string[]) => fake.mget(keys);
        set = async (key: string, value: unknown, opts?: { nx?: boolean }) =>
          (await fake.set(key, value, opts)) ? "OK" : null;
        del = (...keys: string[]) => fake.del(keys);
        incr = fake.incr;
        sadd = fake.sadd;
        srem = fake.srem;
        smembers = fake.smembers;
      },
    }));
    const { getKV } = await import("@/lib/kv");
    const kv = getKV();

    expect(constructed).toHaveBeenCalledWith({ url: "https://example.upstash.io", token: "token" });
    expect(await kv.set("a", { v: 1 })).toBe(true);
    expect(await kv.set("a", { v: 2 }, { nx: true })).toBe(false);
    expect(await kv.get("a")).toEqual({ v: 1 });
    expect(await kv.mget(["a", "b"])).toEqual([{ v: 1 }, null]);
    expect(await kv.mget([])).toEqual([]);
    expect(await kv.incr("n")).toBe(1);
    expect(await kv.sadd("s", "x")).toBe(1);
    expect(await kv.smembers("s")).toEqual(["x"]);
    expect(await kv.srem("s", "x")).toBe(1);
    expect(await kv.del(["a", "n"])).toBe(2);
    expect(await kv.del([])).toBe(0);
  });

  it("uses Upstash Ratelimit with a sliding window per policy", async () => {
    stubCredentials("UPSTASH_REDIS_REST");
    const limit = vi.fn(async () => ({
      success: true,
      limit: 30,
      remaining: 29,
      reset: 123,
      pending: Promise.resolve(),
    }));
    const configs: unknown[] = [];
    vi.doMock("@upstash/redis", () => ({ Redis: class {} }));
    vi.doMock("@upstash/ratelimit", () => ({
      Ratelimit: Object.assign(
        class {
          constructor(config: unknown) {
            configs.push(config);
          }
          limit = limit;
        },
        { slidingWindow: (requests: number, window: string) => ({ requests, window }) },
      ),
    }));
    const { rateLimit: upstashRateLimit } = await import("@/lib/ratelimit");

    expect(await upstashRateLimit("createLink", "key_1")).toEqual({
      success: true,
      limit: 30,
      remaining: 29,
      reset: 123,
    });
    await upstashRateLimit("createLink", "key_2");
    expect(configs).toHaveLength(1); // limiter is reused per policy
    expect(configs[0]).toMatchObject({
      prefix: "ratelimit:createLink",
      limiter: { requests: 30, window: "60 s" },
    });
    expect(limit).toHaveBeenCalledWith("key_2");
  });

  it("fails loudly in production when Redis isn't configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { getKV } = await import("@/lib/kv");
    expect(() => getKV()).toThrow(/Redis is not configured/);
  });
});
