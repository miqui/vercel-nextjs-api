import { describe, expect, it } from "vitest";
import { GET as redirect } from "@/app/[code]/route";
import { POST as createKey } from "@/app/api/keys/route";
import { DELETE as deleteLink, GET as getLink } from "@/app/api/links/[code]/route";
import { GET as listLinks, POST as createLink } from "@/app/api/links/route";
import { POLICIES } from "@/lib/ratelimit";
import { request, routeContext } from "./helpers";

async function newKey(ip = "203.0.113.1"): Promise<string> {
  const res = await createKey(request("POST", "/api/keys", { body: { name: "test" }, ip }));
  expect(res.status).toBe(201);
  return (await res.json()).key;
}

async function shorten(key: string, body: unknown) {
  return createLink(request("POST", "/api/links", { key, body }));
}

describe("POST /api/keys", () => {
  it("issues a key and returns rate limit headers", async () => {
    const res = await createKey(request("POST", "/api/keys", { body: { name: "cli" } }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sk_[A-Za-z0-9_-]{32}$/);
    expect(body).toMatchObject({ name: "cli", id: expect.stringMatching(/^key_/) });
    expect(res.headers.get("X-RateLimit-Limit")).toBe(String(POLICIES.createKey.requests));
  });

  it("defaults the name when there is no body", async () => {
    const res = await createKey(request("POST", "/api/keys"));
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe("default");
  });

  it("rejects an invalid name", async () => {
    const res = await createKey(request("POST", "/api/keys", { body: { name: "" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("rate limits per IP", async () => {
    for (let i = 0; i < POLICIES.createKey.requests; i++) await newKey("198.51.100.7");
    const res = await createKey(request("POST", "/api/keys", { ip: "198.51.100.7" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^\d+$/);
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");

    // Another IP is unaffected.
    expect((await createKey(request("POST", "/api/keys", { ip: "198.51.100.8" }))).status).toBe(201);
  });
});

describe("authentication", () => {
  it("requires an API key", async () => {
    const res = await createLink(request("POST", "/api/links", { body: { url: "https://example.com" } }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("rejects unknown and malformed keys", async () => {
    for (const key of ["sk_doesnotexist", "not-a-key"]) {
      const res = await listLinks(request("GET", "/api/links", { key }));
      expect(res.status).toBe(401);
    }
  });

  it("accepts the X-API-Key header", async () => {
    const key = await newKey();
    const res = await listLinks(request("GET", "/api/links", { headers: { "x-api-key": key } }));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/links", () => {
  it("creates a link with a generated code", async () => {
    const key = await newKey();
    const res = await shorten(key, { url: "https://example.com/some/page?q=1" });
    expect(res.status).toBe(201);
    const link = await res.json();
    expect(link.code).toMatch(/^[A-Za-z0-9]{7}$/);
    expect(link).toMatchObject({
      url: "https://example.com/some/page?q=1",
      clicks: 0,
      shortUrl: `http://localhost:3000/${link.code}`,
    });
  });

  it("creates a link with a custom code and rejects a duplicate", async () => {
    const key = await newKey();
    expect((await shorten(key, { url: "https://example.com", code: "my-link" })).status).toBe(201);
    const res = await shorten(key, { url: "https://example.org", code: "my-link" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("conflict");
  });

  it.each([
    ["missing url", {}],
    ["non-http scheme", { url: "javascript:alert(1)" }],
    ["ftp scheme", { url: "ftp://example.com/file" }],
    ["not a url", { url: "example" }],
    ["too long", { url: `https://example.com/${"a".repeat(2048)}` }],
    ["short code", { url: "https://example.com", code: "ab" }],
    ["bad characters in code", { url: "https://example.com", code: "no spaces" }],
    ["reserved code", { url: "https://example.com", code: "API" }],
  ])("rejects %s", async (_label, body) => {
    const res = await shorten(await newKey(), body);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("rejects malformed JSON", async () => {
    const key = await newKey();
    const res = await createLink(request("POST", "/api/links", { key, rawBody: "{not json" }));
    expect(res.status).toBe(400);
  });

  it("refuses to shorten its own domain", async () => {
    const res = await shorten(await newKey(), { url: "http://localhost:3000/abc1234" });
    expect(res.status).toBe(400);
  });

  it("rate limits link creation per key", async () => {
    const key = await newKey();
    for (let i = 0; i < POLICIES.createLink.requests; i++) {
      expect((await shorten(key, { url: "https://example.com" })).status).toBe(201);
    }
    expect((await shorten(key, { url: "https://example.com" })).status).toBe(429);
    // A different key has its own budget.
    expect((await shorten(await newKey(), { url: "https://example.com" })).status).toBe(201);
  });
});

describe("GET /api/links", () => {
  it("lists only the caller's links, newest first, with clicks", async () => {
    const alice = await newKey();
    const bob = await newKey();
    await shorten(alice, { url: "https://example.com/1", code: "first" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await shorten(alice, { url: "https://example.com/2", code: "second" });
    await shorten(bob, { url: "https://example.com/3", code: "bobs" });
    await redirect(request("GET", "/first"), routeContext({ code: "first" }));

    const res = await listLinks(request("GET", "/api/links", { key: alice }));
    expect(res.status).toBe(200);
    const { links } = await res.json();
    expect(links.map((l: { code: string }) => l.code)).toEqual(["second", "first"]);
    expect(links[1]).toMatchObject({ clicks: 1, shortUrl: "http://localhost:3000/first" });
  });

  it("returns an empty list for a new key", async () => {
    const res = await listLinks(request("GET", "/api/links", { key: await newKey() }));
    expect(await res.json()).toEqual({ links: [] });
  });
});

describe("GET and DELETE /api/links/:code", () => {
  it("returns stats to the owner only", async () => {
    const owner = await newKey();
    await shorten(owner, { url: "https://example.com", code: "stats" });

    const res = await getLink(
      request("GET", "/api/links/stats", { key: owner }),
      routeContext({ code: "stats" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: "stats", clicks: 0 });

    const other = await getLink(
      request("GET", "/api/links/stats", { key: await newKey() }),
      routeContext({ code: "stats" }),
    );
    expect(other.status).toBe(404);
  });

  it("returns 404 for an unknown code", async () => {
    const res = await getLink(
      request("GET", "/api/links/nope", { key: await newKey() }),
      routeContext({ code: "nope" }),
    );
    expect(res.status).toBe(404);
  });

  it("requires a key", async () => {
    expect((await getLink(request("GET", "/api/links/x"), routeContext({ code: "x" }))).status).toBe(401);
    expect((await deleteLink(request("DELETE", "/api/links/x"), routeContext({ code: "x" }))).status).toBe(
      401,
    );
  });

  it("lets only the owner delete, and the code stops redirecting", async () => {
    const owner = await newKey();
    await shorten(owner, { url: "https://example.com", code: "gone" });

    const forbidden = await deleteLink(
      request("DELETE", "/api/links/gone", { key: await newKey() }),
      routeContext({ code: "gone" }),
    );
    expect(forbidden.status).toBe(404);

    const res = await deleteLink(
      request("DELETE", "/api/links/gone", { key: owner }),
      routeContext({ code: "gone" }),
    );
    expect(res.status).toBe(204);
    expect((await redirect(request("GET", "/gone"), routeContext({ code: "gone" }))).status).toBe(404);

    const list = await listLinks(request("GET", "/api/links", { key: owner }));
    expect((await list.json()).links).toEqual([]);
  });
});

describe("GET /:code", () => {
  it("redirects with 307 and counts each click", async () => {
    const key = await newKey();
    expect((await shorten(key, { url: "https://example.com/target", code: "go-to" })).status).toBe(201);

    for (let i = 0; i < 3; i++) {
      const res = await redirect(request("GET", "/go-to"), routeContext({ code: "go-to" }));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://example.com/target");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    const stats = await getLink(request("GET", "/api/links/go-to", { key }), routeContext({ code: "go-to" }));
    expect((await stats.json()).clicks).toBe(3);
  });

  it("returns 404 for unknown or invalid codes", async () => {
    for (const code of ["missing", "x", "bad code!"]) {
      expect((await redirect(request("GET", "/"), routeContext({ code }))).status).toBe(404);
    }
  });
});
