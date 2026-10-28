# Link Shortener API

A URL shortener REST API built with Next.js route handlers, with API keys and rate limiting. Data lives in Upstash Redis.

- **Live API:** https://vercel-nextjs-api.vercel.app
- **OpenAPI 3.2 spec:** [`public/openapi.yaml`](public/openapi.yaml), served at https://vercel-nextjs-api.vercel.app/openapi.yaml

## Endpoints

| Method   | Path               | Auth    | Rate limit        | Description                             |
| -------- | ------------------ | ------- | ----------------- | --------------------------------------- |
| `POST`   | `/api/keys`        | none    | 5 / hour per IP   | Create an API key: `{ name? }`          |
| `POST`   | `/api/links`       | API key | 30 / min per key  | Shorten a URL: `{ url, code? }`         |
| `GET`    | `/api/links`       | API key | 120 / min per key | List your links with click counts       |
| `GET`    | `/api/links/:code` | API key | 120 / min per key | Get one of your links and its clicks    |
| `DELETE` | `/api/links/:code` | API key | 120 / min per key | Delete one of your links                |
| `GET`    | `/:code`           | none    | none              | `307` redirect to the URL, counts click |

## Usage

The examples use the production URL. For local development, set `BASE=http://localhost:3000`. Responses are shown formatted; the API returns compact JSON.

```sh
BASE=https://vercel-nextjs-api.vercel.app
```

### 1. Create an API key

```sh
curl -X POST $BASE/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-cli"}'
```

`201 Created`

```json
{
  "key": "sk_3hT9xQ2mVb7LkP4nW8cR1sY6fJ0dZ5aE",
  "id": "key_8f3a2c1d9e7b6a54",
  "name": "my-cli",
  "createdAt": "2026-10-27T19:30:00.000Z",
  "note": "Store this key now. It cannot be shown again."
}
```

The `key` is shown only once; the server stores just its hash. The body is optional: without it, the key is named `default`. Save the key for the next steps:

```sh
KEY=$(curl -s -X POST $BASE/api/keys -H 'Content-Type: application/json' -d '{"name":"my-cli"}' | jq -r .key)
```

Send it on every `/api/links` request as `Authorization: Bearer $KEY` (or `X-API-Key: $KEY`).

### 2. Shorten a URL

With a custom code:

```sh
curl -X POST $BASE/api/links \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://vercel.com/docs","code":"docs"}'
```

`201 Created`

```json
{
  "code": "docs",
  "url": "https://vercel.com/docs",
  "ownerId": "key_8f3a2c1d9e7b6a54",
  "createdAt": "2026-10-27T19:31:00.000Z",
  "clicks": 0,
  "shortUrl": "https://vercel-nextjs-api.vercel.app/docs"
}
```

Leave out `code` to get a random 7-character one:

```sh
curl -X POST $BASE/api/links \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://nextjs.org/docs/app"}'
```

`201 Created`

```json
{
  "code": "Xk9pQ2r",
  "url": "https://nextjs.org/docs/app",
  "ownerId": "key_8f3a2c1d9e7b6a54",
  "createdAt": "2026-10-27T19:35:00.000Z",
  "clicks": 0,
  "shortUrl": "https://vercel-nextjs-api.vercel.app/Xk9pQ2r"
}
```

Rules:

- `url` must be `http` or `https`, at most 2048 characters, and not on this API's own domain.
- `code` is 3–32 letters, digits, `-` or `_`, and case-sensitive. `api`, `_next`, `favicon.ico`, `robots.txt` and `sitemap.xml` are reserved.
- Codes are unique across all users. A taken code returns `409`.

### 3. Follow the short link

```sh
curl -i $BASE/docs
```

```http
HTTP/2 307
location: https://vercel.com/docs
cache-control: no-store
```

Each visit counts as a click. The redirect is temporary and uncached so that every visit reaches the server.

### 4. List your links

```sh
curl $BASE/api/links -H "Authorization: Bearer $KEY"
```

`200 OK`. Newest first, and only links created with this key:

```json
{
  "links": [
    {
      "code": "Xk9pQ2r",
      "url": "https://nextjs.org/docs/app",
      "ownerId": "key_8f3a2c1d9e7b6a54",
      "createdAt": "2026-10-27T19:35:00.000Z",
      "clicks": 0,
      "shortUrl": "https://vercel-nextjs-api.vercel.app/Xk9pQ2r"
    },
    {
      "code": "docs",
      "url": "https://vercel.com/docs",
      "ownerId": "key_8f3a2c1d9e7b6a54",
      "createdAt": "2026-10-27T19:31:00.000Z",
      "clicks": 2,
      "shortUrl": "https://vercel-nextjs-api.vercel.app/docs"
    }
  ]
}
```

### 5. Get one link's clicks

```sh
curl $BASE/api/links/docs -H "Authorization: Bearer $KEY"
```

`200 OK`

```json
{
  "code": "docs",
  "url": "https://vercel.com/docs",
  "ownerId": "key_8f3a2c1d9e7b6a54",
  "createdAt": "2026-10-27T19:31:00.000Z",
  "clicks": 2,
  "shortUrl": "https://vercel-nextjs-api.vercel.app/docs"
}
```

Links created with a different key return `404`, the same as codes that don't exist.

### 6. Delete a link

```sh
curl -X DELETE $BASE/api/links/docs -H "Authorization: Bearer $KEY"
```

`204 No Content`. The short URL returns `404` afterwards and the code can be reused.

## Rate limits

| Policy     | Applies to                                 | Limit          |
| ---------- | ------------------------------------------ | -------------- |
| createKey  | `POST /api/keys`, per client IP            | 5 per hour     |
| createLink | `POST /api/links`, per API key             | 30 per minute  |
| manage     | other `/api/links` operations, per API key | 120 per minute |

Rate-limited responses carry these headers:

```http
x-ratelimit-limit: 120
x-ratelimit-remaining: 119
x-ratelimit-reset: 1793129460
```

`x-ratelimit-reset` is a Unix time in seconds. Over the limit you get `429` with `Retry-After` (seconds):

```http
HTTP/2 429
retry-after: 42
```

```json
{ "error": { "code": "rate_limited", "message": "Too many requests. Try again later." } }
```

## Errors

Every error has the same shape. Branch on `error.code`; `message` is for humans and its wording may change.

| Status | `error.code`   | When                                         | Example `message`                                        |
| ------ | -------------- | -------------------------------------------- | -------------------------------------------------------- |
| `400`  | `bad_request`  | Invalid or missing body, URL or code         | `✖ Invalid URL\n  → at url`                              |
| `401`  | `unauthorized` | No API key, or an invalid one                | ``Missing API key. Send `Authorization: Bearer <key>`.`` |
| `404`  | `not_found`    | Unknown code, or a link owned by another key | `Link not found.`                                        |
| `409`  | `conflict`     | Custom code already taken                    | `The code "docs" is already taken.`                      |
| `429`  | `rate_limited` | Rate limit exceeded                          | `Too many requests. Try again later.`                    |

For example, shortening a non-HTTP URL:

```sh
curl -X POST $BASE/api/links \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"url":"javascript:alert(1)"}'
```

`400 Bad Request`

```json
{ "error": { "code": "bad_request", "message": "✖ Invalid URL\n  → at url" } }
```

## OpenAPI spec

[`public/openapi.yaml`](public/openapi.yaml) is an OpenAPI 3.2 description of the API, with the same examples as above. Use it to generate clients, import into API tools, or give to AI agents.

```sh
npm run lint:openapi                            # validate the spec and its examples
npx @redocly/cli preview -d public/openapi.yaml # browse it as interactive docs
```

`test/openapi.test.ts` fails if the spec's paths, methods, rate limits or error codes drift from the code.

### Checking every example against a running API (k6)

[`k6/examples.js`](k6/examples.js) sends a request for every example in the spec (request bodies, success responses and every error example) and checks that the status and body match the example exactly. Only values that change per run (keys, IDs, timestamps, generated codes, host) are compared by format. It fails if an example in the spec has no matching scenario, so new examples must be tested. CI runs it on every PR.

Requires [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) (`brew install k6`):

```sh
npm run dev:memory   # terminal 1: dev server forced onto the in-memory store
npm run test:k6      # terminal 2: BASE_URL defaults to http://localhost:3000
```

The suite writes data and deliberately uses up rate limits, so it refuses to run against production. `dev:memory` ignores the Redis credentials in `.env.local`, so it never touches production data.

## Tracing

The app is instrumented with OpenTelemetry via [`@vercel/otel`](https://www.npmjs.com/package/@vercel/otel) (`instrumentation.ts`). On Vercel, traces appear in the project's built-in trace view, which is included in the Hobby plan with short retention.

Besides Next.js's own request spans and outgoing `fetch` calls (Upstash's REST requests), the app adds:

| Span                                          | Attributes                                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `redis GET`, `redis SET`, … (each KV command) | `db.system.name`, `db.operation.name`, `db.operation.batch.size`, `app.kv.key_prefix`, `app.kv.store` |
| `ratelimit <policy>`                          | `app.ratelimit.policy`, `.store`, `.success`, `.limit`, `.remaining`                                  |

Spans record key prefixes (`link`, `apikey`) rather than full keys, and never API keys or client IPs; `test/tracing.test.ts` enforces this. Search recent spans from the CLI:

```sh
vercel traces search --columns span.startTime,span.duration,span.name,span.status.code
vercel traces search --status error
```

## Development

```sh
npm install
npm run dev     # uses an in-memory store when Redis isn't configured
npm run check   # format, lint, OpenAPI lint, typecheck, tests with coverage thresholds
```

The app reads `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`. In production, API requests fail with an error if they're missing.

> **Careful:** `vercel env pull .env.local` (and installing the Upstash integration) writes the **production** Redis credentials to `.env.local`, and `npm run dev` loads that file. Local requests then read and write production data. Remove the `KV_*` lines from `.env.local` to go back to the in-memory store. Tests always use the in-memory store.

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Prettier, ESLint (zero warnings), OpenAPI lint, TypeScript, Vitest with coverage thresholds, production build, `npm audit`, dependency review on PRs and CodeQL.
- **CD**: Vercel's Git integration deploys every merge to `main` to production and every PR to a preview URL. `main` is protected: changes go through PRs, and merging requires the CI checks to pass.
