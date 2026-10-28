// Runs every example in public/openapi.yaml against a live server and checks the API
// responds exactly as documented. Fails if any example in the spec has no scenario here.
//
// Meant for a local or CI server using the in-memory store: it uses up rate limits and
// relies on X-Forwarded-For to isolate per-IP limits, which Vercel overwrites.
//
//   npm run dev:memory   # in another terminal
//   npm run test:k6
import http from "k6/http";
import { check, fail, group } from "k6";

const BASE = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PROD = "https://vercel-nextjs-api.vercel.app";
const spec = JSON.parse(open("./openapi.json"));

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: { checks: ["rate==1"] },
};

// --- Spec examples ----------------------------------------------------------------------

/** Every named example in the spec, keyed "<operationId> <request|status>:<name>" or "<component>:<name>". */
function collectExamples() {
  const all = new Map();
  const add = (prefix, content) => {
    for (const [name, example] of Object.entries(content?.["application/json"]?.examples ?? {})) {
      all.set(`${prefix}:${name}`, example.value);
    }
  };
  for (const item of Object.values(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === "parameters") continue;
      add(`${op.operationId} request`, op.requestBody?.content);
      for (const [status, response] of Object.entries(op.responses)) {
        if (!response.$ref) add(`${op.operationId} ${status}`, response.content);
      }
    }
  }
  for (const [name, response] of Object.entries(spec.components.responses)) add(name, response.content);
  return all;
}

const examples = collectExamples();
const covered = new Set();

function example(id) {
  if (!examples.has(id)) fail(`No example "${id}" in the spec`);
  covered.add(id);
  return JSON.parse(JSON.stringify(examples.get(id)));
}

// --- Matching ---------------------------------------------------------------------------

/** Values that legitimately differ per run, mapped from the spec's sample value to this run's. */
const substitutions = new Map([[PROD, BASE]]);

function substitute(value) {
  if (typeof value === "string") {
    let out = value;
    for (const [from, to] of substitutions) out = out.split(from).join(to);
    return out;
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]));
  }
  return value;
}

/** Fields whose value is random or time-based: only their presence and format are checked. */
const VOLATILE = {
  key: (v) => /^sk_[A-Za-z0-9_-]{32}$/.test(v),
  id: (v) => /^key_[0-9a-f]{16}$/.test(v),
  createdAt: (v) => !Number.isNaN(Date.parse(v)) && v.endsWith("Z"),
};

/** Returns a list of differences between actual and expected (empty when they match). */
function diff(actual, expected, path = "$") {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array`];
    if (actual.length !== expected.length) {
      return [`${path}: expected ${expected.length} items, got ${actual.length}`];
    }
    return expected.flatMap((item, i) => diff(actual[i], item, `${path}[${i}]`));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return [`${path}: expected an object`];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].flatMap((key) => {
      if (!(key in actual)) return [`${path}.${key}: missing`];
      if (!(key in expected)) return [`${path}.${key}: not in the example`];
      if (VOLATILE[key]) return VOLATILE[key](actual[key]) ? [] : [`${path}.${key}: bad format`];
      return diff(actual[key], expected[key], `${path}.${key}`);
    });
  }
  return actual === expected
    ? []
    : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

/** Checks a response's status and that its JSON body matches the spec example `id`. */
function expectExample(res, status, id) {
  const expected = substitute(example(id));
  let body;
  try {
    body = res.json();
  } catch {
    body = undefined;
  }
  const problems = diff(body, expected);
  const ok = check(res, {
    [`${id}: status ${status}`]: (r) => r.status === status,
    [`${id}: body matches example`]: () => problems.length === 0,
  });
  if (!ok) console.error(`${id} (HTTP ${res.status}): ${problems.join("; ") || res.body}`);
  return body;
}

function expectRateLimitHeaders(res, label) {
  check(res, {
    [`${label}: X-RateLimit-* headers`]: (r) =>
      ["X-Ratelimit-Limit", "X-Ratelimit-Remaining", "X-Ratelimit-Reset"].every((h) =>
        /^\d+$/.test(r.headers[h] ?? ""),
      ),
  });
}

// --- Requests ---------------------------------------------------------------------------

// A random /16 per run keeps per-IP rate limits from leaking between runs.
const ipPrefix = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const ip = (n) => `${ipPrefix}.${n}`;

function request(method, path, { body, key, clientIp = ip(1), host } = {}) {
  const headers = { "X-Forwarded-For": clientIp };
  if (host) headers.Host = host;
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return http.request(method, `${BASE}${path}`, body === undefined ? null : JSON.stringify(body), {
    headers,
    redirects: 0,
    responseCallback: http.expectedStatuses({ min: 200, max: 499 }),
  });
}

// --- Scenarios --------------------------------------------------------------------------

export function setup() {
  if (BASE === PROD && __ENV.ALLOW_PRODUCTION !== "1") {
    fail(
      "Refusing to run against production: it writes data and exhausts rate limits. Set ALLOW_PRODUCTION=1 to override.",
    );
  }
  const res = http.get(`${BASE}/`);
  if (res.status !== 200) fail(`${BASE} is not reachable (HTTP ${res.status})`);
}

export default function runExamples() {
  let key;
  let otherKey;
  let generatedCode;

  group("createApiKey", () => {
    const res = request("POST", "/api/keys", { body: example("createApiKey request:named") });
    const created = expectExample(res, 201, "createApiKey 201:created");
    expectRateLimitHeaders(res, "createApiKey 201");
    key = created?.key;
    if (!key) fail("Could not create an API key; later scenarios need one");
    substitutions.set("key_8f3a2c1d9e7b6a54", created.id);

    expectExample(request("POST", "/api/keys", { body: { name: "" } }), 400, "createApiKey 400:emptyName");
    otherKey = request("POST", "/api/keys").json("key");

    // The 6th key from one IP within an hour is rate limited.
    for (let i = 0; i < 5; i++) request("POST", "/api/keys", { clientIp: ip(2) });
    const limited = request("POST", "/api/keys", { clientIp: ip(2) });
    expectExample(limited, 429, "RateLimited:rateLimited");
    check(limited, {
      "RateLimited: Retry-After header": (r) => /^\d+$/.test(r.headers["Retry-After"] ?? ""),
    });
  });

  group("authentication", () => {
    expectExample(request("GET", "/api/links"), 401, "Unauthorized:missing");
    expectExample(request("GET", "/api/links", { key: "sk_invalid" }), 401, "Unauthorized:invalid");
  });

  group("listLinks (empty)", () => {
    const res = request("GET", "/api/links", { key });
    expectExample(res, 200, "listLinks 200:empty");
    expectRateLimitHeaders(res, "listLinks 200");
  });

  group("createLink", () => {
    const custom = request("POST", "/api/links", { key, body: example("createLink request:customCode") });
    expectExample(custom, 201, "createLink 201:customCode");
    expectRateLimitHeaders(custom, "createLink 201");

    const generated = request("POST", "/api/links", {
      key,
      body: example("createLink request:generatedCode"),
    });
    generatedCode = generated.json("code");
    check(generatedCode, {
      "generated code is 7 letters and digits": (c) => /^[A-Za-z0-9]{7}$/.test(c ?? ""),
    });
    substitutions.set("Xk9pQ2r", generatedCode);
    expectExample(generated, 201, "createLink 201:generatedCode");

    const taken = { url: "https://example.com", code: "docs" };
    expectExample(request("POST", "/api/links", { key, body: taken }), 409, "createLink 409:taken");

    const invalid = [
      [{ url: "javascript:alert(1)" }, "createLink 400:invalidUrl"],
      [{ url: "https://example.com", code: "ab" }, "createLink 400:invalidCode"],
    ];
    for (const [body, id] of invalid) expectExample(request("POST", "/api/links", { key, body }), 400, id);

    // URL validation rejects hosts without a dot (like localhost) before the own-domain
    // check runs, so present the server under a dotted name for this request.
    const ownDomain = request("POST", "/api/links", {
      key,
      host: "links.test",
      body: { url: "http://links.test/abc1234" },
    });
    expectExample(ownDomain, 400, "createLink 400:ownDomain");
  });

  group("followShortLink", () => {
    const location = spec.paths["/{code}"].get.responses["307"].headers.Location.example;
    for (let i = 0; i < 2; i++) {
      const res = request("GET", "/docs");
      check(res, {
        "followShortLink 307: status": (r) => r.status === 307,
        "followShortLink 307: Location header example": (r) => r.headers.Location === location,
        "followShortLink 307: Cache-Control no-store": (r) => r.headers["Cache-Control"] === "no-store",
      });
    }
  });

  group("getLink and listLinks (with clicks)", () => {
    expectExample(request("GET", "/api/links/docs", { key }), 200, "getLink 200:clicked");
    expectExample(request("GET", "/api/links", { key }), 200, "listLinks 200:twoLinks");
    // Another key's link looks like it doesn't exist.
    expectExample(request("GET", "/api/links/docs", { key: otherKey }), 404, "NotFound:notFound");
    const res = request("DELETE", "/api/links/docs", { key: otherKey });
    check(res, { "deleteLink by another key: 404": (r) => r.status === 404 });
  });

  group("createLink rate limit", () => {
    for (let i = 0; i < 30; i++) {
      request("POST", "/api/links", { key: otherKey, body: { url: `https://example.com/${i}` } });
    }
    const limited = request("POST", "/api/links", { key: otherKey, body: { url: "https://example.com" } });
    expectExample(limited, 429, "RateLimited:rateLimited");
  });

  group("deleteLink", () => {
    for (const code of ["docs", generatedCode]) {
      const res = request("DELETE", `/api/links/${code}`, { key });
      check(res, {
        [`deleteLink ${code}: 204 with no body`]: (r) => r.status === 204 && !r.body,
      });
    }
    expectExample(request("GET", "/docs"), 404, "NotFoundPublic:notFound");
  });

  group("coverage", () => {
    const missing = [...examples.keys()].filter((id) => !covered.has(id));
    if (missing.length) console.error(`Examples without a scenario: ${missing.join(", ")}`);
    check(missing, { [`all ${examples.size} spec examples exercised`]: (m) => m.length === 0 });
  });
}
