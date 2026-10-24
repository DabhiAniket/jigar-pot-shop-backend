# Security

## Admin authentication

- **Passwords**: Argon2id (19 MiB, t=2), automatically re-hashed if parameters change. Policy:
  ≥12 characters, three character classes, no repeated runs, not containing the email/name,
  not on a common-password list. Never logged, never returned by the API (`select: false`).
- **Sessions**: 32-byte random token in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-jmh_session`
  with `Secure` in production). Only its SHA-256 hash is stored. Idle timeout (default 2 h,
  sliding) and absolute timeout (default 12 h); a TTL index purges expired sessions.
- **CSRF**: every state-changing admin request needs `X-CSRF-Token` = HMAC(APP_SECRET, session
  hash), and browsers' `Origin` must be an allowed origin (cross-site requests are rejected).
- **Brute force**: per-IP and per-IP+email limits on sign-in (Redis-backed when configured),
  account lockout after 8 failures (15 min), identical responses and timing for unknown accounts.
- **Initial Super Admin**: created only by `npm run admin:bootstrap`, only when no admin exists,
  from `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` (strength-checked). The account must
  change its password at first sign-in; until then every other admin endpoint returns 403.
  There is no default or hard-coded login.
- **Password reset**: single-use tokens (hash stored), valid 30 minutes, claimed atomically; a
  reset signs out all sessions. Super admins can issue a link from Admin → Users; self-service
  email reset works when `SMTP_URL` is configured. Reset links are never logged.
- **Sessions management**: users can sign out other sessions; super admins can revoke any user's
  sessions. Changing a role or deactivating an account signs that user out immediately.

### Provisioning and rotating the first credentials

1. Put `BOOTSTRAP_ADMIN_EMAIL` and a strong one-time `BOOTSTRAP_ADMIN_PASSWORD` in the secret store.
2. Run `npm run admin:bootstrap` (or `docker compose run --rm api node dist/bootstrap-admin.js`).
3. Sign in at `/admin/login` and choose a new password when prompted.
4. **Delete `BOOTSTRAP_ADMIN_PASSWORD`** from the environment/secret store. The bootstrap password
   is never valid after step 3.
5. Create individual accounts for staff (Admin → Users) with the least-privileged role.

## Authorisation (enforced by the API on every request)

| Permission area                         | Super Admin | Product Manager |   Order Manager    |
| --------------------------------------- | :---------: | :-------------: | :----------------: |
| Dashboard (sections filtered by role)   |      ✔      | catalogue only  | orders + catalogue |
| Products, categories, images, inventory |      ✔      |        ✔        |     read only      |
| Promotions                              |      ✔      |        ✔        |     read only      |
| Homepage content                        |      ✔      |        ✔        |         —          |
| Orders, customers (personal data)       |      ✔      |        —        |         ✔          |
| Store settings                          |      ✔      |      read       |        read        |
| Admin users, audit log                  |      ✔      |        —        |         —          |

Hiding a button in the UI is never the protection: `requirePermission()` runs on the server.
At least one active Super Admin must always remain, and nobody can demote or deactivate themselves.

## Input, output and transport

- All bodies, queries and params are parsed with Zod schemas that accept only primitives of the
  expected type, so client input can never become a MongoDB operator (NoSQL injection). Unknown
  fields — including client-sent prices, totals, stock or roles — are dropped.
- JSON body limit 200 KB; uploads 15 MB, one file, verified by magic bytes and decoder probe
  (JPEG/PNG/WebP only; SVG/GIF/others rejected), 60-megapixel decompression-bomb limit.
- Helmet headers on the API (deny-all CSP, HSTS in production); the web app sends a CSP,
  `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and Permissions-Policy.
- CORS: explicit allow-list (`PUBLIC_WEB_URL` + `CORS_ORIGINS`); browsers normally call the API
  same-origin through the CDN/LB.
- Logs are structured JSON with cookies, authorization headers, passwords and token query
  parameters redacted. Phone numbers are posted in bodies (order tracking), not URLs.
- Secrets live only in server environment variables. Nothing secret uses a `NEXT_PUBLIC_` prefix.

## Personal data and retention

The shop collects only what fulfilment needs: name, mobile (optional separate WhatsApp), address
for delivery, optional notes. No accounts, no email, no payment data. Public order pages show a
masked phone number and require the HMAC link or the order number **and** phone. Audit events
expire after `AUDIT_RETENTION_DAYS` (default 730). Decide an order-retention period with the
business (tax rules typically require keeping invoices) and archive/delete accordingly.

## Checklist before going live

- [ ] Long random `APP_SECRET`, `REVALIDATE_SECRET`, `INTERNAL_API_TOKEN`, `METRICS_TOKEN`
- [ ] HTTPS everywhere; `COOKIE_SECURE=true`; correct `TRUST_PROXY` hop count
- [ ] Bootstrap password removed after first sign-in; staff have individual accounts
- [ ] MongoDB user with least privilege (readWrite on the app database), IP allow-list/VPC peering
- [ ] **Rotate any database password that has been shared in chat, email or tickets**
- [ ] Object storage: `public/` readable only through the CDN; `private/` never public
- [ ] Edge/WAF rate limiting in front of the app limits
- [ ] `npm audit` reviewed; dependencies kept current
