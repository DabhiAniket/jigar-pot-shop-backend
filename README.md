# Jigar Matka House — backend

REST API and background worker for **Jigar Matka House**, a shop for clay matkas, earthen water
pots, terracotta cookware, planters, festive pottery and other household products.

The storefront and admin panel live in a separate repository,
[`jigar-pot-shop`](https://github.com/DabhiAniket/jigar-pot-shop) (Next.js). It calls this API
through its own domain: browsers request `/api/v1/*` and `/media/*` from the frontend, which
forwards them here.

| Part                                | Tech                                                      | Path                            |
| ----------------------------------- | --------------------------------------------------------- | ------------------------------- |
| REST API + worker                   | Node.js, Express 5, TypeScript, Mongoose 9, Sharp, BullMQ | `src/`                          |
| Shared contracts and business rules | TypeScript + Zod (pricing, permissions, order states, …)  | `shared/` (alias `@jmh/shared`) |
| Vercel Function entry               | Serves the bundled API                                    | `api/index.js`, `vercel.json`   |
| Migrations, seed, admin bootstrap   | tsx scripts                                               | `scripts/`, `seed/`             |
| Container image, compose, nginx     | Docker                                                    | `Dockerfile`, `infra/`          |
| Load tests                          | k6                                                        | `loadtest/`                     |

Documentation: [architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) ·
[security](docs/SECURITY.md) · [media pipeline](docs/MEDIA-PIPELINE.md) ·
[deployment & operations](docs/DEPLOYMENT.md) · [load testing](docs/LOAD-TESTING.md)

## Quick start (development)

Requirements: Node.js 22.12+ (24 recommended), MongoDB 7+ **as a replica set** (transactions),
optionally Docker for Redis.

```bash
npm install
npm run dev:db              # local MongoDB replica set on :27018 (+ Redis on :6380 if Docker is available)
cp .env.example .env        # set APP_SECRET; MONGODB_URI may point at Atlas
npm run db:migrate
npm run admin:bootstrap     # needs BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD in .env
npm run seed:demo           # optional: illustrative demo catalogue (refuses to run in production)
npm run dev                 # API on :4000 (also npm run dev:worker when REDIS_URL is set)
```

Then run the frontend (`jigar-pot-shop`, `npm run dev` on :3000) and open
<http://localhost:3000/admin>. The first sign-in forces a password change; then remove
`BOOTSTRAP_ADMIN_PASSWORD` from `.env`.

## Shared contracts (`shared/`)

`shared/` holds the Zod input schemas, DTO types, pricing engine, order state machine, role
permissions and WhatsApp message builder. **This repository is the source of truth.** The
frontend keeps an identical copy for its types and display helpers. After changing anything here:

```bash
npm test                                             # contracts are tested here (shared/test)
npm run shared:export -- ../jigar-pot-shop           # copy into the frontend checkout; commit there too
npm run shared:export -- ../jigar-pot-shop --check   # exits 1 if the two copies differ
```

The API validates every request itself, so an outdated frontend copy can never weaken validation.
Deploy the backend first when a contract change is backwards compatible.

## Quality gates

```bash
npm run typecheck
npm run lint
npm test                 # shared unit tests + API integration tests (in-memory MongoDB replica set)
npm run build            # tsup bundle in dist/
```

End-to-end tests live in the frontend repository and run against an isolated API from this one
(database `jmh_e2e`, never the development or production database):

```bash
scripts/e2e-stack.sh prepare && scripts/e2e-stack.sh api     # API on :4100
# then in jigar-pot-shop: scripts/e2e-web.sh, and E2E_BASE_URL=http://localhost:3100 npm run test:e2e
```

## Deployment

- **Vercel**: import this repository and keep the repository root as the root directory.
  `vercel.json` configures the rest. Environment variables and limits are in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- **Containers**: `docker build -t jmh-api .` builds one image for both the API
  (`node dist/server.js`) and the worker (`node dist/worker.js`). `infra/compose/` runs the full
  stack on one host.
