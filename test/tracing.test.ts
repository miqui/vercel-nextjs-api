import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as createKey } from "@/app/api/keys/route";
import { POST as createLink } from "@/app/api/links/route";
import { POLICIES } from "@/lib/ratelimit";
import { withSpan } from "@/lib/tracing";
import { request } from "./helpers";

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const contextManager = new AsyncLocalStorageContextManager();

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  contextManager.disable();
  trace.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

const spans = () => exporter.getFinishedSpans();
const named = (name: string) => spans().filter((span) => span.name === name);
const parentId = (span: ReadableSpan) => span.parentSpanContext?.spanId;

async function newKey(ip = "203.0.113.9"): Promise<string> {
  return (await (await createKey(request("POST", "/api/keys", { ip }))).json()).key;
}

describe("tracing", () => {
  it("traces the rate limiter with its policy and outcome", async () => {
    await createKey(request("POST", "/api/keys"));

    const [span] = named("ratelimit createKey");
    expect(span.attributes).toEqual({
      "app.ratelimit.policy": "createKey",
      "app.ratelimit.store": "memory",
      "app.ratelimit.success": true,
      "app.ratelimit.limit": POLICIES.createKey.requests,
      "app.ratelimit.remaining": POLICIES.createKey.requests - 1,
    });
  });

  it("marks rate-limited requests as unsuccessful", async () => {
    for (let i = 0; i <= POLICIES.createKey.requests; i++) await createKey(request("POST", "/api/keys"));

    const last = named("ratelimit createKey").at(-1)!;
    expect(last.attributes["app.ratelimit.success"]).toBe(false);
    expect(last.attributes["app.ratelimit.remaining"]).toBe(0);
  });

  it("traces each Redis command with its operation and key prefix", async () => {
    const key = await newKey();
    exporter.reset();
    await createLink(
      request("POST", "/api/links", { key, body: { url: "https://example.com", code: "traced" } }),
    );

    expect(spans().map((span) => span.name)).toEqual([
      "redis GET", // look up the API key
      "ratelimit createLink",
      "redis SET", // store the link
      "redis SADD", // add it to the owner's list
    ]);
    expect(named("redis SET")[0].attributes).toEqual({
      "db.system.name": "redis",
      "db.operation.name": "SET",
      "db.operation.batch.size": 1,
      "app.kv.key_prefix": "link",
      "app.kv.store": "memory",
    });
    expect(named("redis GET")[0].attributes["app.kv.key_prefix"]).toBe("apikey");
  });

  it("never records API keys, client IPs or full Redis keys", async () => {
    const ip = "198.51.100.42";
    const key = await newKey(ip);
    await createLink(
      request("POST", "/api/links", { key, body: { url: "https://example.com", code: "secret-code" } }),
    );

    const recorded = JSON.stringify(spans().map((span) => [span.name, span.attributes]));
    for (const value of [key, ip, "secret-code", "link:", "apikey:"]) {
      expect(recorded).not.toContain(value);
    }
  });

  it("nests spans started inside a span, and records errors", async () => {
    await expect(
      withSpan("outer", {}, () =>
        withSpan("inner", {}, async () => {
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");

    const [outer] = named("outer");
    const [inner] = named("inner");
    expect(parentId(inner)).toBe(outer.spanContext().spanId);
    for (const span of [inner, outer]) {
      expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: "boom" });
      expect(span.events.map((event) => event.name)).toContain("exception");
    }
  });
});
