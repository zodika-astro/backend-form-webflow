// modules/birthchart/router.js
'use strict';

/**
 * Birthchart routes (public)
 * -------------------------
 * Exposes the public submission endpoint for the multi-step form.
 *
 * Mounting (index.js):
 *   app.use('/birthchart', formLimiter, birthchartRouter);
 *   └─ Therefore, the local route path here must be **'/birthchartsubmit-form'**.
 *
 * Middleware order:
 *   1) refererAuth     → origin/referer enforcement (defense-in-depth)
 *   2) verifyRecaptcha → requires privacy consent + verifies reCAPTCHA v3 (server-side)
 *   3) controller      → business logic (validation, persistence, PSP checkout)
 *
 * Security notes:
 *   - The reCAPTCHA middleware removes sensitive fields (token/consent) from req.body
 *     after verification and attaches a minimal result to req.security.recaptcha.
 *   - Do not log request bodies from public forms; rely on structured logs only.
 */

const express = require('express');
const router = express.Router();

const refererAuth = require('../../middlewares/refererAuth');
const verifyRecaptcha = require('../../middlewares/recaptcha'); // expects: body.privacyConsent + body.recaptchaToken
const controller = require('./controller');

// POST /birthchart/birthchartsubmit-form  (mounted under '/birthchart')
router.post(
  '/birthchartsubmit-form',
  refererAuth,
  verifyRecaptcha,
  controller.processForm
);

module.exports = router;
