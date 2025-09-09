// modules/birthchart/validators.js
'use strict';

const { z } = require('zod');

/**
 * Birthchart validators (Zod)
 * --------------------------
 * Objectives
 * - Strong, reusable schemas with clear error messages.
 * - Trim/normalize inputs (lowercasing emails, coercing numbers when safe).
 * - Validate date/time formats AND logical ranges (YYYY-MM-DD, HH:MM, lat/lng ranges).
 * - Accept structured objects for "birth_place_json" (not only JSON strings).
 * - Enforce reasonable max lengths to prevent oversized public payloads.
 *
 * Security/PII
 * - Do not log full public payloads; surface only paths/messages.
 * - Keep messages user-friendly without leaking sensitive details.
 *
 * Business rule
 * - reCAPTCHA token is mandatory. We consolidate it from multiple common keys
 *   and expose it as `captcha_token` for the rest of the application.
 */

/* --------------------------------- Helpers --------------------------------- */

/** Validate YYYY-MM-DD with calendar bounds (UTC, no timezone shifts). */
function isValidISODate(yyyyMMdd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(yyyyMMdd)) return false;
  const [y, m, d] = yyyyMMdd.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() + 1 === m &&
    dt.getUTCDate() === d
  );
}

/** Validate HH:MM (24h). */
function isValidHHmm(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return false;
  const [h, m] = hhmm.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** Today's date as YYYY-MM-DD in UTC (safe for lexicographic comparison). */
function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Safe parse:
 * - Accepts an object or a JSON string.
 * - Returns an object or undefined (never throws).
 */
function parseOptionalJson(value) {
  if (value == null) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  if (typeof value === 'string') {
    try {
      const obj = JSON.parse(value);
      return typeof obj === 'object' && obj !== null ? obj : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Consolidate captcha token from multiple common client keys.
 * If absent or empty, returns null (validation will reject it later).
 */
function pickCaptchaToken(body = {}) {
  const c =
    body.captcha_token ??
    body.captchaToken ??
    body.recaptcha_token ??
    body.recaptchaToken ??
    body['g-recaptcha-response'] ??
    body.g_recaptcha_response ??
    body.captcha ??
    null;

  if (c == null) return null;
  const s = String(c).trim();
  return s.length ? s : null;
}

/* ------------------------------ Reusable pieces ----------------------------- */

const NameSchema = z
  .string({ required_error: 'name is required', invalid_type_error: 'name must be a string' })
  .trim()
  .min(3, 'name must have at least 3 characters')
  .max(60, 'name must have at most 60 characters');

const OptionalSocialNameSchema = z
  .union([z.string().trim(), z.literal(''), z.null(), z.undefined()])
  .transform((v) => {
    if (v == null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  })
  .refine((v) => v === undefined || v.length <= 40, {
    message: 'social_name must have at most 40 characters',
  });

const EmailSchema = z
  .string({ required_error: 'email is required', invalid_type_error: 'email must be a string' })
  .trim()
  .max(254, 'email must have at most 254 characters')
  .email('invalid email format')
  .transform((e) => e.toLowerCase());

const DateYMD = z
  .string({ required_error: 'birth_date is required', invalid_type_error: 'birth_date must be a string' })
  .trim()
  .refine(isValidISODate, 'date format must be YYYY-MM-DD')
  .refine((v) => v >= '1700-01-01', 'date must be on/after 1700-01-01')
  .refine((v) => v <= todayYMD(), 'date cannot be in the future');

const TimeHHmm = z
  .string({ required_error: 'birth_time is required', invalid_type_error: 'birth_time must be a string' })
  .trim()
  .refine(isValidHHmm, 'time format must be HH:MM');

const BirthPlaceSchema = z
  .string({ required_error: 'birth_place is required', invalid_type_error: 'birth_place must be a string' })
  .trim()
  .min(2, 'birth_place must have at least 2 characters')
  .max(120, 'birth_place must have at most 120 characters');

/**
 * Product type is currently fixed by business requirements.
 * Normalize to lowercase first, then enforce the literal.
 */
const ProductTypeSchema = z
  .string({ required_error: 'product_type is required', invalid_type_error: 'product_type must be a string' })
  .transform((s) => String(s).trim().toLowerCase())
  .refine((s) => s === 'birth_chart', { message: 'invalid product_type' });

const CountryCodeSchema = z
  .string({ invalid_type_error: 'birth_place_country must be a string' })
  .trim()
  .length(2, 'birth_place_country must be a 2-letter code')
  .transform((s) => s.toUpperCase())
  .optional();

const OptionalAdminText = z.string().trim().min(1).max(120).optional();

const PlaceIdSchema = z
  .string({ invalid_type_error: 'birth_place_place_id must be a string' })
  .trim()
  .min(10, 'birth_place_place_id seems too short')
  .max(128, 'birth_place_place_id is too long')
  .regex(/^[A-Za-z0-9_\-]+$/, 'birth_place_place_id has invalid characters')
  .optional();

const OptionalLat = z
  .union([z.coerce.number(), z.string().trim().length(0)])
  .transform((v) => (typeof v === 'number' ? v : undefined))
  .refine((v) => v === undefined || (v >= -90 && v <= 90), 'birth_place_lat must be between -90 and 90')
  .optional();

const OptionalLng = z
  .union([z.coerce.number(), z.string().trim().length(0)])
  .transform((v) => (typeof v === 'number' ? v : undefined))
  .refine((v) => v === undefined || (v >= -180 && v <= 180), 'birth_place_lng must be between -180 and 180')
  .optional();

/**
 * Accept either:
 * - a JSON string up to 10 kB, or
 * - a plain object
 * Transform to an object (or undefined) and lightly validate shape.
 */
const OptionalJson = z
  .union([z.string().max(10_000, 'birth_place_json string is too large'), z.record(z.any())])
  .optional()
  .transform((v) => parseOptionalJson(v))
  .refine((obj) => obj === undefined || typeof obj === 'object', 'birth_place_json must be a JSON object')
  .refine(
    (obj) => obj === undefined || typeof obj.place_id === 'string' || obj.place_id === undefined,
    'birth_place_json.place_id must be a string when present'
  );

const OptionalTzId = z.string().trim().min(1).max(128).optional();

const OptionalUtcOffsetMin = z
  .union([z.coerce.number(), z.string().trim().length(0)])
  .transform((v) => (typeof v === 'number' ? v : undefined))
  .refine((v) => v === undefined || (Number.isFinite(v) && v >= -720 && v <= 840), 'birth_utc_offset_min must be a number between -720 and 840')
  .optional();

/* ------------------------------- Root schema -------------------------------- */
/**
 * Wrap the root schema with z.preprocess to:
 * - Consolidate a captcha token into `captcha_token` (mandatory).
 * - Keep the rest of the structure intact (strict mode remains).
 */
const birthchartSchema = z.preprocess(
  (raw) => {
    const obj = raw && typeof raw === 'object' ? { ...raw } : {};
    if (!obj.captcha_token) {
      const tok = pickCaptchaToken(obj);
      if (tok) obj.captcha_token = tok;
    }
    return obj;
  },
  z
    .object({
      name: NameSchema,
      social_name: OptionalSocialNameSchema,
      email: EmailSchema,
      birth_date: DateYMD,
      birth_time: TimeHHmm,
      birth_place: BirthPlaceSchema,
      product_type: ProductTypeSchema,

      birth_place_place_id: PlaceIdSchema,
      birth_place_full: z.string().trim().min(2).max(200).optional(),
      birth_place_country: CountryCodeSchema,
      birth_place_admin1: OptionalAdminText,
      birth_place_admin2: OptionalAdminText,

      // Accept numbers or numeric strings; coerce and enforce ranges.
      birth_place_lat: OptionalLat,
      birth_place_lng: OptionalLng,

      // Accept stringified JSON or object; transform to object when possible.
      birth_place_json: OptionalJson,

      // Optional timezone id and offset (may be computed server-side).
      birth_timezone_id: OptionalTzId,
      birth_utc_offset_min: OptionalUtcOffsetMin,

      // ===== reCAPTCHA & consent (added to cooperate with strict mode) =====
      // Consolidated token: REQUIRED
      captcha_token: z.string().trim().min(1, 'reCAPTCHA token is missing'),
      // Optional metadata
      recaptcha_action: z.string().trim().min(1).optional(),
      captcha_provider: z.string().trim().min(1).optional(),
      // Allow alternative client keys (optional; ignored if present)
      recaptcha_token: z.string().optional(),
      recaptchaToken: z.string().optional(),
      captchaToken: z.string().optional(),
      captcha: z.string().optional(),
      'g-recaptcha-response': z.string().optional(),
      g_recaptcha_response: z.string().optional(),

      // Consent flags (optional; accepted to avoid strict() rejections)
      privacyConsent: z.coerce.boolean().optional(),
      privacy_agreed: z.coerce.boolean().optional(),
    })
    .strict()
);

/* ----------------------------- Public API (module) -------------------------- */
/**
 * Validate and normalize the public form payload.
 * @param {unknown} payload
 * @returns {object} Parsed data (normalized)
 * @throws {Error} ValidationError with `status = 400` and `details` (flattened issues)
 */
function validateBirthchartPayload(payload) {
  const result = birthchartSchema.safeParse(payload);
  if (result.success) return result.data;

  // Compact error for a centralized error handler
  const flattened = result.error.flatten();
  const err = new Error('Validation Error');
  err.name = 'ValidationError';
  err.status = 400;
  err.details = {
    fieldErrors: flattened.fieldErrors, // { field: [messages] }
    formErrors: flattened.formErrors,   // array of top-level messages
  };
  throw err;
}

module.exports = {
  validateBirthchartPayload,
  birthchartSchema,
};
