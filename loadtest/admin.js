// k6 admin workload: sign-in + order list, using a dedicated TEST admin account.
//   k6 run -e API_URL=http://localhost:4100/api/v1 -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... loadtest/admin.js
// Keep VUs small: admin traffic is a handful of staff, and login is deliberately slow (Argon2id)
// and rate-limited. Disable app rate limits only in the isolated test environment.
import http from 'k6/http';
import { check, sleep } from 'k6';

const API = __ENV.API_URL || 'http://localhost:4100/api/v1';
export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || '1m',
  thresholds: { http_req_failed: ['rate<0.01'], 'http_req_duration{name:orders}': ['p(95)<800'] },
};

export function setup() {
  const res = http.post(
    `${API}/admin/auth/login`,
    JSON.stringify({ email: __ENV.ADMIN_EMAIL, password: __ENV.ADMIN_PASSWORD }),
    {
      headers: { 'content-type': 'application/json' },
    },
  );
  if (res.status !== 200)
    throw new Error(`Admin sign-in failed with ${res.status}: check ADMIN_EMAIL/ADMIN_PASSWORD`);
  if (res.json('data.mustChangePassword')) {
    throw new Error(
      'This test admin must change its temporary password first (sign in once at /admin/login).',
    );
  }
  const cookie = res.cookies.jmh_session?.[0] ?? res.cookies['__Host-jmh_session']?.[0];
  return { cookie: `${cookie.name}=${cookie.value}` };
}

export default function (data) {
  const headers = { cookie: data.cookie };
  const list = http.get(`${API}/admin/orders?limit=25&page=${1 + Math.floor(Math.random() * 3)}`, {
    headers,
    tags: { name: 'orders' },
  });
  check(list, { 'orders 200': (r) => r.status === 200 });
  const dashboard = http.get(`${API}/admin/dashboard`, { headers, tags: { name: 'dashboard' } });
  check(dashboard, { 'dashboard 200': (r) => r.status === 200 });
  sleep(2);
}
