# Architecture

## Components

```
Browser ──► CDN / load balancer ──┬──► web (Next.js, N instances)  ── server fetch ──┐
                                  ├──► /api/*  ─────────────────────────────────────► api (Express, N instances) ──► MongoDB (replica set / Atlas)
                                  └──► /media/* ──► object storage (S3/R2) via CDN       │                         ──► Redis (rate limits, cache, queue)
                                                                                        └──► BullMQ ──► worker (Sharp image processing)
```

- **web** renders the storefront with React Server Components. Catalogue data is fetched from the
  API and kept in the Next.js data cache (`revalidate` 60–300 s, tags `catalog`, `settings`,
  `home`, `promotions`). The API calls `POST /api/revalidate` after edits so pages refresh
  promptly. Product and homepage HTML is ISR-cached and CDN-cacheable (`s-maxage`). Only the
  cart, checkout and admin are client-heavy.
- **api** is stateless: sessions live in MongoDB, rate-limit counters and the catalogue cache in
  Redis, files in object storage. Any instance can serve any request.
- **worker** consumes image jobs from Redis (BullMQ) so Sharp never competes with API requests.
  Without Redis (development) jobs run in a bounded in-process queue inside the API.
- **shared/** holds the rules both sides must agree on: Zod input schemas, DTO types,
  the pricing engine, order state machine, role permissions and the WhatsApp message builder.
  It lives in this backend repository (source of truth, tested here) and is exported as an
  identical copy into the frontend repository (`npm run shared:export`).
  The **API is the only authority** for prices, discounts, stock and totals; the browser only
  displays server quotes.

## Data model (MongoDB)

| Collection                                           | Purpose                                                                                                         | Key indexes                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `products`                                           | catalogue, variants, denormalised image refs, derived fields (`minEffectivePrice`, `inStock`, `onSale`, `rank`) | unique `slug`; unique partial `sku`; `previousSlugs`; `{status, category, publishedAt}`; `{status, rank, publishedAt}`; `{status, minEffectivePrice}`; `{status, category, minEffectivePrice}`; `{status, onSale/isFeatured/isBestseller, publishedAt}`; weighted text index; `images.asset` |
| `categories`                                         | admin-managed categories                                                                                        | unique `slug`; `{isActive, sortOrder}`                                                                                                                                                                                                                                                       |
| `mediaassets`                                        | uploaded images and their WebP variants                                                                         | `{status, updatedAt}` (stuck-job sweep), `createdAt`                                                                                                                                                                                                                                         |
| `orders`                                             | immutable item/price snapshots, status history, notes, inventory flags                                          | unique `orderNumber`; unique partial `idempotencyKey`; `{status, createdAt}`; `{customer.phone, createdAt}`; `{customerId, createdAt}`                                                                                                                                                       |
| `customers`                                          | one per phone number (no customer accounts)                                                                     | unique `phone`; `lastOrderAt`                                                                                                                                                                                                                                                                |
| `inventorymovements`                                 | every stock change with reason/actor                                                                            | `{product, createdAt}`; **unique `{order, reason, product, variant}`** (no double deduction/restock)                                                                                                                                                                                         |
| `promotions`                                         | time-boxed automatic or coupon promotions + banners                                                             | `{isActive, endsAt, startsAt}`; unique partial `code`                                                                                                                                                                                                                                        |
| `adminusers`, `adminsessions`, `passwordresettokens` | staff auth                                                                                                      | unique `email`; unique `tokenHash`; TTL on `expiresAt`                                                                                                                                                                                                                                       |
| `auditevents`                                        | sensitive admin actions                                                                                         | `{entityType, entityId, createdAt}`, `{actor, createdAt}`, `{action, createdAt}`, TTL retention (default 730 days)                                                                                                                                                                           |
| `store_settings`, `home_content`                     | singletons                                                                                                      | —                                                                                                                                                                                                                                                                                            |
| `migrations`                                         | applied migration ids                                                                                           | —                                                                                                                                                                                                                                                                                            |

Money is stored as **integer paise** everywhere. Lists are always paginated and bounded
(storefront ≤ 48, admin ≤ 100 per page).

## Order lifecycle

```
pending ─► awaiting_confirmation ─► confirmed ─► processing ─► ready_for_dispatch ─► shipped ─► delivered ─► refunded
   │                │                   │             │                 │   └───────────────────► delivered
   └────────────────┴───────────────────┴─────────────┴─────────────────┴──► cancelled ─► refunded
```

- Checkout (one transaction): re-read products → validate availability → price with live
  promotions → conditional stock decrements (`stock >= qty`) → upsert customer → insert order and
  inventory movements. Write conflicts retry the whole transaction automatically.
- Idempotency: the client sends a per-attempt `Idempotency-Key`; the unique index makes concurrent
  retries collapse into one order, and a different body with the same key is rejected (422).
- Order numbers: `JMH-YYMMDD-XXXXX` (India date + 5 Crockford-base32 characters), unique index
  with retry on collision. Confirmation links carry an HMAC token, so numbers cannot be enumerated.
- Cancelling restocks reserved items exactly once (status-guarded update + unique movement index).
  Refunds after delivery do not restock automatically (returned pottery may be damaged).
- WhatsApp: `https://wa.me/<digits>?text=<encoded message built from the saved order>`. The
  customer reviews and sends it; nothing changes the order status automatically.

## Pricing rules

1. Unit price = sale price when lower than the regular price (per variant if variants exist).
2. At most **one** promotion applies: the largest discount among live automatic promotions and
   a valid entered code. Percentage promotions can be capped; all can require a minimum order.
3. The discount is spread across the eligible lines proportionally with exact integer maths.
4. Delivery: free for store pickup; otherwise the flat charge, waived once the discounted total
   reaches the free-delivery threshold.

## Caching

| Layer                 | What                                                                             | TTL / invalidation                           |
| --------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| CDN                   | `/_next/static`, `/media/*` (immutable, content-addressed by asset id)           | 1 year                                       |
| CDN                   | ISR pages (`/`, `/products/*`) and public API responses                          | `s-maxage` 60–300 s + stale-while-revalidate |
| Next.js data cache    | API responses used by server components                                          | 60–300 s + tag revalidation from the API     |
| API                   | public catalogue reads (memory ≤15 s per instance + Redis, versioned namespaces) | bumped on every catalogue write              |
| Never cached publicly | carts, quotes, orders, admin, settings writes                                    | `Cache-Control: no-store`                    |

With several Next.js instances each keeps its own data cache; on-demand revalidation reaches the
instance that receives the call, others refresh within their TTL. Configure a shared Next.js
cache handler (e.g. Redis) if instant cross-instance refresh matters.

## Bilingual content

English is the primary language (`<html lang="en-IN">`); Gujarati text (hero headline, product and
category names) is marked `lang="gu"` and set in Noto Serif Gujarati. Each product has one URL, so
there are no duplicate-language pages. Separate `/gu` routes with `hreflang` can be added later.
