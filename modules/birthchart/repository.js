// modules/birthchart/validators.js
'use strict';

const { z } = require('zod');

/**
 * Birthchart validators (Zod)
 * --------------------------
 * Goals:
 *  - Strong, reusable schemas with clear error messages.
 *  - Trim/normalize inputs (lowercasing emails, coercing numbers when safe).
 *  - Validate date/time format AND logical ranges (HH:MM, lat/lng ranges).
 *  - Accept structured objects for "birth_place_json" (not only stringified JSON).
 *  - NEW: Tolerate CAPTCHA/Privacy fields from the public form (server enforces them via middleware).
 *
 * Security/PII notes:
 *  - Do not log full payloads from public forms; surface only validation paths/messages.
 *  - Keep error messages user-friendly and non-verbose to avoid leaking data.
 */

/* --------------------------------- Helpers --------------------------------- */

/** Validate YYYY-MM-DD with calendar bounds (no timezone shifts). */
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

/** Validate HH:MM 24h. */
function isValidHHmm(hhmm) {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return false;
  const [h, m] = hhmm.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** Safe JSON parse that accepts either string or object and returns an object, or undefined. */
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

/* ------------------------------ Reusable pieces ----------------------------- */

const NameSchema = z
  .string({ required_error: 'name is required', invalid_type_error: 'name must be a string' })
  .trim()
  .min(3, 'name must have at least 3 characters');

const OptionalSocialNameSchema = z
  .union([
    z.string().trim(),
    z.literal(''),
    z.null(),
    z.undefined(),
  ])
  .transform((v) => {
    if (v == null) return undefined;
    const s = String(v).trim();
    return s === '' ? undefined : s;
  })
  .refine((v) => v === undefined || v.length <= 20, {
    message: 'social_name must have at most 20 characters',
  });

const EmailSchema = z
  .string({ required_error: 'email is required', invalid_type_error: 'email must be a string' })
  .trim()
  .email('invalid email format')
  .transform((e) => e.toLowerCase());

const DateYMD = z
  .string({ required_error: 'birth_date is required', invalid_type_error: 'birth_date must be a string' })
  .trim()
  .refine(isValidISODate, 'date format must be YYYY-MM-DD');

const TimeHHmm = z
  .string({ required_error: 'birth_time is required', invalid_type_error: 'birth_time must be a string' })
  .trim()
  .refine(isValidHHmm, 'time format must be HH:MM');

const BirthPlaceSchema = z
  .string({ required_error: 'birth_place is required', invalid_type_error: 'birth_place must be a string' })
  .trim()
  .min(2, 'birth place must have at least 2 characters');

const ProductTypeSchema = z
  .string({ required_error: 'product_type is required', invalid_type_error: 'product_type must be a string' })
  .trim()
  .min(3, 'product_type must have at least 3 characters')
  .transform((s) => s.toLowerCase());

const CountryCodeSchema = z
  .string({ invalid_type_error: 'birth_place_country must be a string' })
  .trim()
  .length(2, 'birth_place_country must be a 2-letter code')
  .transform((s) => s.toUpperCase())
  .optional();

const OptionalShortText = z.string().trim().min(1).optional();

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

const OptionalJson = z
  .any()
  .optional()
  .transform((v) => parseOptionalJson(v));

const OptionalTzId = z.string().trim().min(1).optional();

const OptionalUtcOffsetMin = z
  .union([z.coerce.number(), z.string().trim().length(0)])
  .transform((v) => (typeof v === 'number' ? v : undefined))
  .refine(
    (v) => v === undefined || (Number.isFinite(v) && v >= -720 && v <= 840),
    'birth_utc_offset_min must be a number between -720 and 840'
  )
  .optional();

/* ----- NEW: optional fields coming from the frontend (CAPTCHA & Privacy) ----- */

/** Accepts booleans or common truthy/falsey strings, normalized to boolean. */
const OptionalBoolish = z
  .union([
    z.boolean(),
    z.string().trim().toLowerCase().transform((s) => ['true', '1', 'yes', 'on'].includes(s)),
    z.number().transform((n) => n === 1),
  ])
  .optional();

/** reCAPTCHA token and action are optional (server middleware verifies token). */
const OptionalCaptchaToken  = z.string().trim().min(1).optional();
const OptionalCaptchaAction = z.string().trim().min(1).optional();

/* ------------------------------- Root schema -------------------------------- */

const birthchartSchema = z
  .object({
    // core fields
    name: NameSchema,
    social_name: OptionalSocialNameSchema,
    email: EmailSchema,
    birth_date: DateYMD,
    birth_time: TimeHHmm,
    birth_place: BirthPlaceSchema,
    product_type: ProductTypeSchema,

    birth_place_place_id: OptionalShortText,
    birth_place_full: OptionalShortText,
    birth_place_country: CountryCodeSchema,
    birth_place_admin1: OptionalShortText,
    birth_place_admin2: OptionalShortText,

    birth_place_lat: OptionalLat,
    birth_place_lng: OptionalLng,

    birth_place_json: OptionalJson,

    // optional timezone fields (system may compute server-side)
    birth_timezone_id: OptionalTzId,
    birth_utc_offset_min: OptionalUtcOffsetMin,

    // NEW: tolerated fields from the public form (verified by middleware)
    privacy_agreed: OptionalBoolish,
    recaptcha_token: OptionalCaptchaToken,
    recaptcha_action: OptionalCaptchaAction,
  })
  .strict(); // Reject any other unexpected keys

/* ----------------------------- Public API (module) -------------------------- */

/**
 * Validates and normalizes the public form payload.
 * @param {unknown} payload
 * @returns {object} Parsed data (normalized)
 * @throws {Error} ValidationError with `status = 400` and `details` (flattened issues)
 */
function validateBirthchartPayload(payload) {
  const result = birthchartSchema.safeParse(payload);
  if (result.success) return result.data;

  const flattened = result.error.flatten();
  const err = new Error('Validation Error');
  err.name = 'ValidationError';
  err.status = 400;
  err.details = {
    fieldErrors: flattened.fieldErrors,
    formErrors: flattened.formErrors,
  };
  throw err;
}

module.exports = {
  validateBirthchartPayload,
  birthchartSchema,
};
