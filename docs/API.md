# REST API (`/api/v1`)

Responses: `{ "data": … }`, lists `{ "data": [...], "meta": { page, limit, total, totalPages } }`,
errors `{ "error": { code, message, fields?, requestId } }`. Amounts are integer **paise**.
Request and response types live in `shared/src/types.ts`; input schemas in
`shared/src/schemas` (the frontend repository keeps an exported copy).

## Public

| Method | Path                          | Notes                                                                                                                                                            |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`, `/ready`           | liveness / readiness (DB, Redis, storage) — outside `/api/v1`                                                                                                    |
| GET    | `/metrics`                    | Prometheus text; needs `Authorization: Bearer $METRICS_TOKEN`                                                                                                    |
| GET    | `/settings`                   | public store details, delivery rules, live promotion banners                                                                                                     |
| GET    | `/policies/:key`              | `shipping`, `returns`, `privacy`, `terms`                                                                                                                        |
| GET    | `/home`                       | homepage content + categories + product sections                                                                                                                 |
| GET    | `/categories`                 | active categories with published counts                                                                                                                          |
| GET    | `/products`                   | `q, category, sort (featured/newest/price_asc/price_desc/name_asc), inStock, onSale, featured, bestseller, minPrice, maxPrice (₹), ids, exclude, page, limit≤48` |
| GET    | `/products/:slug`             | detail, or `{ redirectTo }` for a renamed slug                                                                                                                   |
| GET    | `/products/:slug/related`     | up to 8                                                                                                                                                          |
| POST   | `/cart/quote`                 | `{ items[{productId, variantId?, quantity}], promoCode?, fulfillment }` → authoritative totals + per-line issues                                                 |
| POST   | `/orders`                     | checkout; header `Idempotency-Key` (16–64 chars) recommended; 201 new, 200 replay, 409 cart changed/sold out, 422 key reused, 503 busy (retry with the same key) |
| GET    | `/orders/:orderNumber?token=` | confirmation (HMAC token from checkout)                                                                                                                          |
| POST   | `/orders/track`               | `{ orderNumber, phone }`                                                                                                                                         |
| GET    | `/seo/sitemap`                | slugs + `updatedAt`                                                                                                                                              |

## Admin (`/admin`, session cookie + `X-CSRF-Token` on writes)

| Area               | Endpoints                                                                                                                                                                                   | Permission                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Auth               | `POST auth/login`, `POST auth/logout`, `GET auth/me`, `POST auth/change-password`, `POST auth/forgot-password`, `POST auth/reset-password`, `GET auth/sessions`, `DELETE auth/sessions/:id` | —                                      |
| Dashboard          | `GET dashboard`                                                                                                                                                                             | `dashboard:read` (sections by role)    |
| Products           | `GET/POST products`, `GET/PUT/DELETE products/:id` (PUT takes `version` = last `updatedAt`), `POST products/:id/duplicate`, `POST products/bulk`                                            | `products:read/write/delete`           |
| Categories         | `GET/POST categories`, `PUT/DELETE categories/:id`, `POST categories/reorder`                                                                                                               | `categories:write`                     |
| Media              | `POST media` (multipart `file`, `crop` JSON, `alt`), `GET media`, `GET/PATCH/DELETE media/:id`                                                                                              | `media:read/write`                     |
| Inventory          | `GET inventory`, `GET inventory/movements`, `POST inventory/adjust`                                                                                                                         | `inventory:read/write`                 |
| Orders             | `GET orders` (`q, status, channel, from, to`), `GET orders/:id`, `POST orders/:id/status`, `POST orders/:id/notes`                                                                          | `orders:read/write`                    |
| Customers          | `GET customers`, `GET customers/:id`                                                                                                                                                        | `customers:read`                       |
| Promotions         | `GET/POST promotions`, `GET/PUT/DELETE promotions/:id`                                                                                                                                      | `promotions:read/write`                |
| Content & settings | `GET/PUT content/home`, `GET/PUT settings`                                                                                                                                                  | `content:write`, `settings:read/write` |
| Users              | `GET/POST users`, `PATCH users/:id`, `POST users/:id/revoke-sessions`, `POST users/:id/reset-link`                                                                                          | `users:manage`                         |
| Audit              | `GET audit` (`action, entityType, entityId, actorId`)                                                                                                                                       | `audit:read`                           |

Rate limits (per IP unless noted; shared via Redis when configured): global 600/min, sign-in 20 per
15 min and 6 per IP+email per 15 min, password recovery 6/hour, cart quote 120/min, order creation
30 per 10 min, order tracking 30 per 10 min, uploads 120 per 10 min per admin.
