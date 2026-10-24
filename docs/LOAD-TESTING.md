# Load testing

**Target (architecture goal, not yet proven in production):** 5,000–20,000 concurrent visitors.
The numbers below are what was **measured on a single developer laptop**. They are evidence for
the tested workload only and must be re-run on staging hardware that matches production before
any capacity claim is made.

## Workload model (`loadtest/storefront.js`)

A "virtual user" (VU) is one visitor taking a step every 1–4 s (think time), not a request in
flight. Per step: 55 % browse (home/collection), 25 % product page + product API, 12 % search,
6 % cart quote, 2 % checkout (real order + stock deduction, pickup, unique Idempotency-Key).
Stages: ramp-up → sustained → 30 s ramp-down. Thresholds: errors < 1 %, API p95 < 500 ms,
page p95 < 1.5 s, order p95 < 1.5 s.

`PAGES=0` models the production setup where a CDN serves HTML/ISR pages: visitors then generate
only API traffic (catalogue data, quotes, orders). `loadtest/admin.js` covers admin sign-in,
order list and dashboard with a dedicated test account.

**Never point these scripts at production.** They create real orders. Use the isolated stack:

```bash
scripts/e2e-stack.sh prepare && scripts/e2e-stack.sh api &   # API :4100, database jmh_e2e
(cd ../jigar-pot-shop && scripts/e2e-web.sh) &               # frontend production build :3100
docker run --rm --network host -v $PWD/loadtest:/scripts grafana/k6:1.3.0 run \
  -e BASE_URL=http://localhost:3100 -e API_URL=http://localhost:4100/api/v1 \
  -e PEAK_VUS=1000 -e RAMP=2m -e HOLD=3m [-e PAGES=0] /scripts/storefront.js
```

## Environment of the runs (22 Oct 2026)

One laptop (8 logical CPUs, 15 GB RAM) running **everything**: k6, one Next.js production
server, **one** API process (via `tsx`, no clustering), local single-node MongoDB 8.0 replica
set (WiredTiger cache 0.5 GB), no Redis, no CDN, app rate limits off. The first runs shared
the CPU with unrelated heavy processes (3D rendering); later runs did not. Demo catalogue of
18 products (14 simple + 4 with variants), stock raised to 100,000 for order tests.

## Results

| Run                        | Peak VUs | Duration |   Req/s |  Failed | p50 / p95 / p99       | Notes                                                                                                                                              |
| -------------------------- | -------: | -------- | ------: | ------: | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full stack (pages + API)   |      200 | 4.5 min  |      81 | 0.57 %¹ | 11 / 161 / 399 ms     | All thresholds pass. Pages p95 213 ms, API p95 9 ms, orders p95 63 ms.                                                                             |
| Full stack (pages + API)   |    1,000 | 5.5 min  |     165 |   1.0 % | 76 ms / 15.9 s / 54 s | **Single Next.js process saturated** (~100 dynamic page renders/s); API stayed at p95 6 ms, 833/833 orders OK.                                     |
| API tier only (`PAGES=0`)  |    1,000 | 5.5 min  |     308 |     0 % | 1.6 / 19 / 48 ms      | All thresholds pass; 2,048/2,048 orders, order p95 100 ms.                                                                                         |
| API tier only, before fix² |    3,000 | 4.5 min  |     479 |   1.3 % | 74 ms / 5.5 s / 60 s  | Orders hung on transaction retries; machine also busy with other work.                                                                             |
| API tier only, after fix²  |    3,000 | 4.5 min  | **860** | **0 %** | 1.0 / 8.9 / 27 ms     | All thresholds pass; 4,561/4,561 orders, order p95 58 ms, 21 DB connections.                                                                       |
| API tier only              |    5,000 | 5.5 min  |   1,304 |   1.5 % | —                     | **Single API process at its CPU limit.** Browse/search/quote 99.9 % OK; 6,327 checkouts got fast `503 CHECKOUT_BUSY` (by design), 2,441 succeeded. |

¹ 409 "sold out" responses after the demo stock ran out — correct behaviour, counted by k6 as failed HTTP.
² Fix: checkout transactions now retry write conflicts for at most 8 s with jittered backoff and
then fail fast with 503 (retry-safe via Idempotency-Key), instead of the driver default of up to
120 s while holding a pooled connection; default pool raised to 50. The before/after runs also
differ in background machine load, so the improvement is not attributable to the fix alone.

Admin scenario (`loadtest/admin.js`, 10 staff VUs, 1 min, ~12,000 orders in the database):
0 % errors, order list p95 32 ms, overall p95 41 ms including live dashboard aggregations.
With millions of orders, move dashboard figures to pre-aggregated counters or a reporting replica.

**Data integrity after ~12,000 load-test orders:** every order has exactly one inventory movement
per line, units ordered = units deducted (12,072 = 12,072), no negative stock, no duplicate order
numbers.

## Findings and bottlenecks

1. **Next.js render tier**: one `next start` process handled ~100 dynamic page renders/s before
   queueing. Collection and shop pages are dynamic (they read search params); home and product
   pages are ISR (`x-nextjs-cache: HIT`, ~7 ms). Production needs several web instances and a
   CDN honouring `s-maxage` so most HTML never reaches Node.
2. **API**: one process (one core) served ~860 req/s with p95 < 10 ms and saturated near
   ~1,300 req/s. Scale horizontally (stateless; N instances behind the load balancer).
3. **Checkout contention**: thousands of simultaneous checkouts on a handful of products
   conflict on the same stock documents. Bounded retries keep the API healthy; real shops spread
   orders across many products and far lower order rates.
4. **Compression matters**: uncompressed homepage HTML is ~300 KB (43 KB gzipped). The k6 script
   sends `Accept-Encoding` like browsers do; ensure the CDN/LB compresses.

## Rough sizing for the 5,000–20,000 visitor target (to be validated on staging)

Using the measured ~0.3 requests/s per visitor (with think time):

| Visitors | Requests/s (all) | With CDN serving pages (API share ~60 %) | Suggested starting point                                                    |
| -------: | ---------------: | ---------------------------------------: | --------------------------------------------------------------------------- |
|    5,000 |           ~1,500 |                                     ~900 | CDN; 3× web, 2–3× API (1 vCPU each); Atlas M30; Redis                       |
|   20,000 |           ~6,000 |                                   ~3,600 | CDN; 6–8× web, 6–8× API; Atlas M40+ with read-heavy catalogue cached; Redis |

Peak **orders/s**, not visitors, drives database sizing: at a 2 % checkout step rate, 20,000
visitors ≈ 120 orders/s, which needs testing against the real catalogue size and Atlas tier.

## Next steps before claiming the target

- Run the same scripts on staging with production-like instances, Atlas tier, Redis (shared rate
  limits and cache) and the CDN, at 5k / 10k / 20k VUs from distributed k6 load generators.
- Record CPU, memory, event-loop delay (`/metrics`), Atlas connections and slow-query logs per run.
- Re-run after enabling a shared Next.js cache handler if several web instances are used.
