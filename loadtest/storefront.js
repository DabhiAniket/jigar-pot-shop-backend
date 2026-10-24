// k6 storefront workload. Run ONLY against an isolated, non-production environment with test data
// (orders are real records in the target database; WhatsApp is never contacted — the API only
// builds a link).
//
//   k6 run -e BASE_URL=http://localhost:3100 -e PEAK_VUS=200 loadtest/storefront.js
//
// Workload model (per virtual user iteration ≈ one visitor step, with think time):
//   55% browse homepage/collections, 25% product detail, 12% search & filter,
//    6% cart quote, 2% checkout (order creation, pickup, unique idempotency key).
// "Concurrent users" here means VUs with 1–4 s think time, not simultaneous requests.
import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3100';
const API = __ENV.API_URL || `${BASE}/api/v1`;
const PEAK = Number(__ENV.PEAK_VUS || 100);
const RAMP = __ENV.RAMP || '1m';
const HOLD = __ENV.HOLD || '3m';
const ORDER_RATE = Number(__ENV.ORDER_RATE || 0.02);
// PAGES=0 models a CDN serving the HTML: visitors only generate API traffic (data fetches,
// quotes, orders). Use it to measure the backend separately from the Next.js render tier.
const PAGES = __ENV.PAGES !== '0';

export const options = {
  // Browsers always accept compressed responses; without this k6 downloads ~7× more bytes.
  headers: { 'Accept-Encoding': 'gzip, br' },
  scenarios: {
    visitors: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: PEAK }, // ramp-up
        { duration: HOLD, target: PEAK }, // sustained
        { duration: '30s', target: 0 }, // ramp-down
      ],
      gracefulRampDown: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{kind:page}': ['p(95)<1500'],
    'http_req_duration{kind:api}': ['p(95)<500'],
    'http_req_duration{kind:order}': ['p(95)<1500'],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const orderLatency = new Trend('order_create_ms', true);
const orderOk = new Rate('order_success');

export function setup() {
  const res = http.get(`${API}/products?limit=48&inStock=true`);
  const products = res.json('data') || [];
  const simple = products
    .filter((p) => !p.hasVariants && p.availability === 'in_stock')
    .map((p) => ({ id: p.id, slug: p.slug }));
  const categories = (http.get(`${API}/categories`).json('data') || []).map((c) => c.slug);
  if (simple.length === 0)
    throw new Error('No in-stock products found — seed the test database first.');
  return { simple, categories, slugs: products.map((p) => p.slug) };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default function (data) {
  const roll = Math.random();
  if (roll < 0.55) {
    group('browse', () => {
      const res = PAGES
        ? http.get(
            Math.random() < 0.5 ? `${BASE}/` : `${BASE}/collections/${pick(data.categories)}`,
            {
              tags: { kind: 'page' },
            },
          )
        : http.get(
            Math.random() < 0.5
              ? `${API}/home`
              : `${API}/products?category=${pick(data.categories)}`,
            {
              tags: { kind: 'api' },
            },
          );
      check(res, { 'page 200': (r) => r.status === 200 });
    });
  } else if (roll < 0.8) {
    group('product', () => {
      if (PAGES) {
        const res = http.get(`${BASE}/products/${pick(data.slugs)}`, { tags: { kind: 'page' } });
        check(res, { 'product 200': (r) => r.status === 200 });
      }
      const api = http.get(`${API}/products/${pick(data.slugs)}`, { tags: { kind: 'api' } });
      check(api, { 'product api 200': (r) => r.status === 200 });
    });
  } else if (roll < 0.92) {
    group('search', () => {
      const q = pick(['matka', 'planter', 'diya', 'surahi', 'handi', 'kulhad']);
      const res = http.get(
        `${API}/products?q=${q}&sort=${pick(['featured', 'price_asc', 'newest'])}`,
        { tags: { kind: 'api' } },
      );
      check(res, { 'search 200': (r) => r.status === 200 });
    });
  } else if (roll < 1 - ORDER_RATE) {
    group('cart', () => {
      const product = pick(data.simple);
      const res = http.post(
        `${API}/cart/quote`,
        JSON.stringify({ items: [{ productId: product.id, quantity: 1 }], fulfillment: 'pickup' }),
        {
          headers: { 'content-type': 'application/json' },
          tags: { kind: 'api' },
        },
      );
      check(res, { 'quote 200': (r) => r.status === 200 });
    });
  } else {
    group('checkout', () => {
      const product = pick(data.simple);
      const key = `k6-${__VU}-${__ITER}-${Date.now()}`.padEnd(20, '0');
      const res = http.post(
        `${API}/orders`,
        JSON.stringify({
          items: [{ productId: product.id, quantity: 1 }],
          fulfillment: 'pickup',
          channel: 'website',
          customer: {
            name: 'Load Test',
            phone: `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
          },
          notes: 'k6 load test — not a real order',
        }),
        {
          headers: { 'content-type': 'application/json', 'idempotency-key': key },
          tags: { kind: 'order' },
        },
      );
      orderLatency.add(res.timings.duration);
      // 409 = sold out under load, which is correct behaviour, not an error.
      const ok = res.status === 201 || res.status === 409;
      orderOk.add(res.status === 201);
      check(res, { 'order created or sold out': () => ok });
    });
  }
  sleep(1 + Math.random() * 3);
}
