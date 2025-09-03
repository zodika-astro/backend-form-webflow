-- 2025-09-02_add_lgpd_retention_events.sql
-- Purpose:
--   - Add LGPD/GDPR metadata to event logs (legal basis + PII scope).
--   - Add data retention controls via an "expires_at" column.
--   - Create supporting indexes.
--
-- Scope: mp_events, pagbank_events
-- Retention policy: 365 days for events (adjustable by altering the default).

BEGIN;

-- =========================
-- 1) Mercado Pago - mp_events
-- =========================

-- 1.1 Add columns (nullable first to allow backfill without long table locks)
ALTER TABLE public.mp_events
  ADD COLUMN IF NOT EXISTS legal_basis TEXT,
  ADD COLUMN IF NOT EXISTS pii_scope   TEXT,
  ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;

-- 1.2 Backfill:
--     - legal_basis: default to 'contract' (execution of contract / pre-contractual measures).
--     - pii_scope  : a short tag to describe PII handling; default 'minimal'.
--     - expires_at : 365 days after received_at (or now() if missing).
UPDATE public.mp_events
   SET legal_basis = COALESCE(legal_basis, 'contract'),
       pii_scope   = COALESCE(pii_scope,   'minimal'),
       expires_at  = COALESCE(expires_at, (COALESCE(received_at, now()) + INTERVAL '365 days'))
 WHERE legal_basis IS NULL
    OR pii_scope   IS NULL
    OR expires_at  IS NULL;

-- 1.3 Enforce constraints and defaults
ALTER TABLE public.mp_events
  ALTER COLUMN legal_basis SET NOT NULL,
  ALTER COLUMN pii_scope   SET NOT NULL,
  ALTER COLUMN expires_at  SET NOT NULL;

-- Allowed legal bases (LGPD/GDPR-ish). Use CHECK instead of ENUM to avoid migration churn.
ALTER TABLE public.mp_events
  ADD CONSTRAINT ck_mp_events_legal_basis
  CHECK (legal_basis IN (
    'contract',             -- execução de contrato/medidas pré-contratuais (LGPD art. 7º, V)
    'legitimate_interest',  -- interesse legítimo (art. 7º, IX)
    'consent',              -- consentimento (art. 7º, I)
    'legal_obligation',     -- obrigação legal/regulatória (art. 7º, II)
    'vital_interest',       -- proteção da vida/saúde (art. 7º, VII)
    'public_task'           -- execução de políticas públicas (art. 7º, III)
  ));

-- Defaults for new rows
ALTER TABLE public.mp_events
  ALTER COLUMN legal_basis SET DEFAULT 'contract',
  ALTER COLUMN pii_scope   SET DEFAULT 'minimal',
  ALTER COLUMN expires_at  SET DEFAULT (now() + INTERVAL '365 days');

-- 1.4 Indexes to speed up retention sweeps and audits
CREATE INDEX IF NOT EXISTS idx_mp_events_expires_at  ON public.mp_events (expires_at);
CREATE INDEX IF NOT EXISTS idx_mp_events_legal_basis ON public.mp_events (legal_basis);

-- =========================
-- 2) PagBank - pagbank_events
-- =========================

ALTER TABLE public.pagbank_events
  ADD COLUMN IF NOT EXISTS legal_basis TEXT,
  ADD COLUMN IF NOT EXISTS pii_scope   TEXT,
  ADD COLUMN IF NOT EXISTS expires_at  TIMESTAMPTZ;

UPDATE public.pagbank_events
   SET legal_basis = COALESCE(legal_basis, 'contract'),
       pii_scope   = COALESCE(pii_scope,   'minimal'),
       expires_at  = COALESCE(expires_at, (COALESCE(received_at, now()) + INTERVAL '365 days'))
 WHERE legal_basis IS NULL
    OR pii_scope   IS NULL
    OR expires_at  IS NULL;

ALTER TABLE public.pagbank_events
  ALTER COLUMN legal_basis SET NOT NULL,
  ALTER COLUMN pii_scope   SET NOT NULL,
  ALTER COLUMN expires_at  SET NOT NULL;

ALTER TABLE public.pagbank_events
  ADD CONSTRAINT ck_pagbank_events_legal_basis
  CHECK (legal_basis IN (
    'contract',
    'legitimate_interest',
    'consent',
    'legal_obligation',
    'vital_interest',
    'public_task'
  ));

ALTER TABLE public.pagbank_events
  ALTER COLUMN legal_basis SET DEFAULT 'contract',
  ALTER COLUMN pii_scope   SET DEFAULT 'minimal',
  ALTER COLUMN expires_at  SET DEFAULT (now() + INTERVAL '365 days');

CREATE INDEX IF NOT EXISTS idx_pagbank_events_expires_at  ON public.pagbank_events (expires_at);
CREATE INDEX IF NOT EXISTS idx_pagbank_events_legal_basis ON public.pagbank_events (legal_basis);

-- =========================
-- 3) Optional: helper function for scheduled purge
-- =========================
-- This function removes expired rows. You can schedule it via:
--  - pg_cron (if available in your managed Postgres), or
--  - an application-level job (Node cron) calling: SELECT purge_expired_events();
CREATE OR REPLACE FUNCTION public.purge_expired_events()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- Use small batches in very large tables if needed (e.g., LIMIT + loop)
  DELETE FROM public.mp_events      WHERE expires_at <= now();
  DELETE FROM public.pagbank_events WHERE expires_at <= now();
END;
$$;

COMMIT;
