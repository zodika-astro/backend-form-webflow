# Zodika Backend — Forms & Payments

Node.js/Express backend for the "Birthchart" form flow, featuring payment integrations (Mercado Pago and PagBank), idempotent webhooks, and basic observability (health/metrics/logs).

## TL;DR

- **Stack:** Node.js 18+, Express, PostgreSQL
- **Payments:** Mercado Pago (default) and PagBank (toggleable by a feature flag)
- **Webhooks:** Signature/HMAC verification + timestamp tolerance (soft-fail, never drops)
- **Logs:** Structured, with a _correlation id_ (`X-Request-Id`) and domain-based categories
- **Errors:** `AppError` + `errorCodes` with standardized `code` and `status`
- **Observability:** `/health` / `/healthz` / `/metrics` (Prometheus if enabled)

---

## Architecture (at a glance)

A modular monolith:
- `modules/birthchart` → validation (Zod), controller, repository
- `payments/mercadoPago` and `payments/pagBank` → services, webhooks, repositories
- `middlewares` → CORS, webhook auth, metrics, error handler, correlation-id
- `utils` → `httpClient` (undici + retries/backoff), `logger`, `appError`, `errorCodes`
- `observability/healthz` → simple DB ping

> If volume grows, consider moving webhooks to a queue/worker and introducing canonical tables. For now, the focus is on low-to-medium volume with strong idempotence.

---

## Endpoints (matrix)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Simple healthcheck (string `OK`). |
| GET | `/healthz` | Healthcheck with **DB ping** (returns JSON with status). |
| GET | `/metrics` | Prometheus metrics (if `prom-client` is installed). |
| POST | `/birthchart` | Public form submission; creates a checkout with the selected PSP. |
| POST | `/webhook/mercadopago/:secret` | Mercado Pago webhook (raw body + signature/HMAC). |
| POST | `/webhook/pagbank/:secret` | PagBank webhook (raw body + signature). |
| GET | `/mercadoPago/return/success` | Return URL (success) — used by MP. |
| GET | `/mercadoPago/return/pending` | Return URL (pending) — used by MP. |
| GET | `/pagbank/return` | PagBank return URL. |
| GET | `/assets/*` | Static, cached files. |

> Webhooks are protected by: (1) a path secret (`/webhook/*/:secret`), (2) signature verification (`x-signature`), and (3) timestamp tolerance (stale/future → `soft-fail`, but we **never** drop the event).

---

## Environment Variables

| Name | Example / Notes |
|---|---|
| `NODE_ENV` | `production` (recommended for production) |
| `PORT` | Defaults to `3000` |
| `DATABASE_URL` | PostgreSQL connection string |
| `ALLOWED_ORIGINS` | Comma-separated list of origins for CORS |
| `ALLOWED_REFERERS` | Comma-separated list of accepted referrers |
| `TRUST_PROXY_HOPS` | `1` in prod (behind a proxy/LB), `0` for local |
| `PUBLIC_BASE_URL` | Public backend base URL (used for return links) |
| `PAYMENT_FAILURE_URL` | Fallback URL for checkout errors |
| `WEBHOOK_PATH_SECRET` | Path secret for webhooks (route suffix) |
| `ALLOW_UNSIGNED_WEBHOOKS` | `false` in production |
| `Maps_API_KEY` | Key for Time Zone API (via secret provider) |
| `MP_ACCESS_TOKEN` | Mercado Pago access token |
| `MP_WEBHOOK_SECRET` | Webhook secret/HMAC |
| `MP_WEBHOOK_URL` | Public MP webhook URL |
| `PAGBANK_ENABLED` | `true`/`false` (feature flag) |
| `PAGBANK_API_TOKEN` | PagBank token |
| `PAGBANK_BASE_URL` | Ex.: `https://sandbox.api.pagseg
