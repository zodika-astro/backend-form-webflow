# Zodika Backend — Forms & Payments

Backend Node.js/Express para o fluxo do formulário “Birthchart” com integrações de pagamento (Mercado Pago e PagBank), webhooks idempotentes e observabilidade básica (health/metrics/logs).

## TL;DR

- **Stack:** Node.js 18+, Express, PostgreSQL
- **Pagamentos:** Mercado Pago (default) e PagBank (habilitável por flag)
- **Webhooks:** Assinatura/HMAC + tolerância de timestamp (soft-fail, nunca dropa)
- **Logs:** Estruturados, com _correlation id_ (`X-Request-Id`) e categorias por domínio
- **Erros:** `AppError` + `errorCodes` com `code` e `status` padronizados
- **Observabilidade:** `/health` / `/healthz` / `/metrics` (Prometheus se habilitado)

---

## Arquitetura (resumo)

Monólito modular:
- `modules/birthchart` → validação (Zod), controller, repositório
- `payments/mercadoPago` e `payments/pagBank` → services, webhooks, repos
- `middlewares` → CORS, webhook auth, métricas, error handler, correlation-id
- `utils` → `httpClient` (undici + retries/backoff), `logger`, `appError`, `errorCodes`
- `observability/healthz` → DB ping simples

> Quando o volume crescer: mover webhooks para fila/worker e introduzir tabelas canônicas. Por enquanto, foco em baixo/médio volume com forte idempotência.

---

## Endpoints (matriz)

| Método | Caminho                                      | Descrição                                                                 |
|-------:|----------------------------------------------|---------------------------------------------------------------------------|
| GET    | `/health`                                    | Healthcheck simples (string `OK`).                                        |
| GET    | `/healthz`                                   | Healthcheck com **DB ping** (retorna JSON com status).                    |
| GET    | `/metrics`                                   | Métricas Prometheus (se `prom-client` instalado).                         |
| POST   | `/birthchart`                                | Submissão pública do formulário; cria checkout no PSP selecionado.        |
| POST   | `/webhook/mercadopago/:secret`               | Webhook do Mercado Pago (raw body + assinatura/HMAC).                     |
| POST   | `/webhook/pagbank/:secret`                   | Webhook do PagBank (raw body + assinatura).                               |
| GET    | `/mercadoPago/return/success`                | Return URL (success) — usado pelo MP.                                     |
| GET    | `/mercadoPago/return/pending`                | Return URL (pending) — usado pelo MP.                                     |
| GET    | `/pagbank/return`                            | Return URL do PagBank.                                                    |
| GET    | `/assets/*`                                  | Arquivos estáticos, cacheados.                                            |

> Os webhooks são protegidos por: (1) path secret (`/webhook/*/:secret`), (2) verificação de assinatura (`x-signature`) e (3) tolerância de timestamp (stale/future → `soft-fail`, mas **nunca** descartamos o evento).

---

## Variáveis de Ambiente

| Nome                      | Exemplo / Notas                                                                 |
|---------------------------|----------------------------------------------------------------------------------|
| `NODE_ENV`               | `production` (recomendado em prod)                                               |
| `PORT`                   | Padrão `3000`                                                                    |
| `DATABASE_URL`           | String de conexão PostgreSQL                                                     |
| `ALLOWED_ORIGINS`        | CSV de origens para CORS                                                         |
| `ALLOWED_REFERERS`       | CSV de referers aceitos                                                          |
| `TRUST_PROXY_HOPS`       | `1` em prod (atrás de um proxy/LB), `0` local                                    |
| `PUBLIC_BASE_URL`        | Base pública do backend (usada em retornos/links)                                |
| `PAYMENT_FAILURE_URL`    | URL de fallback para erro no checkout                                            |
| `WEBHOOK_PATH_SECRET`    | Segredo do path para webhooks (sufixo da rota)                                   |
| `ALLOW_UNSIGNED_WEBHOOKS`| `false` em prod                                                                  |
| `GOOGLE_MAPS_API_KEY`    | Chave para Time Zone API (via secret provider)                                   |
| `MP_ACCESS_TOKEN`        | Access token do Mercado Pago                                                      |
| `MP_WEBHOOK_SECRET`      | Segredo/HMAC do webhook                                                          |
| `MP_WEBHOOK_URL`         | URL pública do webhook do MP                                                     |
| `PAGBANK_ENABLED`        | `true`/`false` (feature flag)                                                    |
| `PAGBANK_API_TOKEN`      | Token do PagBank                                                                 |
| `PAGBANK_BASE_URL`       | Ex.: `https://sandbox.api.pagseguro.com` (ou prod)                               |
| `PAGBANK_WEBHOOK_URL`    | URL pública do webhook do PagBank                                                |

> **Segredos** são lidos via `config/secretProvider`. Evite acessá-los diretamente com `process.env` fora de `config/env`/provider.

---

## Execução local

```bash
# 1) Instale deps
npm i

# 2) Configure .env (use as variáveis acima)
cp .env.example .env

# 3) Rodar
npm run dev  # se tiver nodemon
# ou
node index.js
