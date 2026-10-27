# Link Shortener API

A URL shortener REST API built with Next.js route handlers, with API keys and rate limiting. Data lives in Upstash Redis.

## API

| Method   | Path               | Auth    | Rate limit        | Description                             |
| -------- | ------------------ | ------- | ----------------- | --------------------------------------- |
| `POST`   | `/api/keys`        | none    | 5 / hour per IP   | Create an API key: `{ name? }`          |
| `POST`   | `/api/links`       | API key | 30 / min per key  | Shorten a URL: `{ url, code? }`         |
| `GET`    | `/api/links`       | API key | 120 / min per key | List your links with click counts       |
| `GET`    | `/api/links/:code` | API key | 120 / min per key | Get one of your links and its clicks    |
| `DELETE` | `/api/links/:code` | API key | 120 / min per key | Delete one of your links                |
| `GET`    | `/:code`           | none    | none              | `307` redirect to the URL, counts click |

Send the key as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Keys are shown once and stored only as SHA-256 hashes.

Rate-limited responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`; over the limit you get `429` with `Retry-After`. Errors have the shape `{ "error": { "code", "message" } }`.

```sh
KEY=$(curl -s -X POST localhost:3000/api/keys | jq -r .key)
curl -s -X POST localhost:3000/api/links -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"url":"https://vercel.com/docs","code":"docs"}'
curl -i localhost:3000/docs
```

## Development

```sh
npm install
npm run dev     # uses an in-memory store when Redis isn't configured
npm run check   # format, lint, typecheck, tests with coverage thresholds
```

To use Redis locally, pull the project's environment variables with `vercel env pull .env.local`. The app reads `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` or `KV_REST_API_URL`/`KV_REST_API_TOKEN`. In production it refuses to start without them.

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Prettier, ESLint (zero warnings), TypeScript, Vitest with coverage thresholds, production build, `npm audit`, dependency review on PRs and CodeQL.
- **CD**: Vercel's Git integration deploys every push to `main` to production and every PR to a preview URL. Protect `main` so merges require the CI checks to pass.
