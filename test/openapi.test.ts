import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { POLICIES } from "@/lib/ratelimit";

type Spec = {
  info: { description: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: { Error: { properties: { error: { properties: { code: { enum: string[] } } } } } } };
};

const ROOT = join(__dirname, "..");
const spec = parse(readFileSync(join(ROOT, "public/openapi.yaml"), "utf8")) as Spec;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Maps each app/**\/route.ts file to its URL path in OpenAPI form, e.g. /api/links/{code}. */
function routeFiles(dir = join(ROOT, "app")): { path: string; file: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    if (entry.name !== "route.ts") return [];
    const segments = relative(join(ROOT, "app"), dir).split(sep).filter(Boolean);
    const path = "/" + segments.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/");
    return [{ path, file: full }];
  });
}

describe("OpenAPI spec", () => {
  const routes = routeFiles();

  it("documents exactly the implemented routes", () => {
    expect(Object.keys(spec.paths).sort()).toEqual(routes.map((r) => r.path).sort());
  });

  it.each(routeFiles())("documents exactly the methods exported by $path", async ({ path, file }) => {
    const handlers = await import(file);
    const implemented = HTTP_METHODS.filter((m) => typeof handlers[m] === "function").map((m) =>
      m.toLowerCase(),
    );
    const documented = Object.keys(spec.paths[path]).filter((key) => key !== "parameters");
    expect(documented.sort()).toEqual(implemented.sort());
  });

  it("states the rate limits the code enforces", () => {
    const { createKey, createLink, manage } = POLICIES;
    expect(createKey.windowSeconds).toBe(3600);
    expect(spec.info.description).toContain(`| ${createKey.requests} per hour |`);
    expect(createLink.windowSeconds).toBe(60);
    expect(spec.info.description).toContain(`| ${createLink.requests} per minute |`);
    expect(manage.windowSeconds).toBe(60);
    expect(spec.info.description).toContain(`| ${manage.requests} per minute |`);
  });

  it("lists every error code the API can return", () => {
    const source = readFileSync(join(ROOT, "lib/http.ts"), "utf8");
    const codes = source.match(/export type ErrorCode =([^;]+);/)![1].match(/"([a-z_]+)"/g)!;
    expect(spec.components.schemas.Error.properties.error.properties.code.enum.sort()).toEqual(
      codes.map((c) => c.replaceAll('"', "")).sort(),
    );
  });
});
