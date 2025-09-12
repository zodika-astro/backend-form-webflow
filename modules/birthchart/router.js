// modules/birthchart/router.js
'use strict';

/**
 * Birthchart routes (public)
 * -------------------------
 * Exposes the public endpoint that receives submissions from the multi-step form.
 *
 * Mounting (index.js):
 *   app.use('/birthchart', formLimiter, birthchartRouter);
 *   └─ This means the local path here must be '/birthchartsubmit-form'.
 *
 * Middleware order (important):
 *   1) refererAuth
 *      - Enforces allowed origins/referers (defense-in-depth).
 *   2) verifyRecaptcha
 *      - Requires explicit privacy consent and validates reCAPTCHA token server-side.
 *      - Removes sensitive fields (consent/token) from req.body and attaches
 *        a minimal result to req.security.recaptcha on success.
 *   3) controller.processForm
 *      - Business logic: validation, persistence, and payment checkout creation.
 *
 * Security notes:
 *   - Never log raw request bodies from public forms; rely on structured logs only.
 */

const express = require('express');
const router = express.Router();

const refererAuth = require('../../middlewares/refererAuth');
const verifyRecaptcha = require('../../middlewares/recaptcha'); // expects: body.privacyConsent + body.recaptcha_token|recaptchaToken
const controller = require('./controller');

/**
 * POST /birthchart/birthchartsubmit-form
 * Mounted under '/birthchart' at the application level.
 */
router.post(
  '/birthchartsubmit-form',
  refererAuth,
  controller.processForm
);

module.exports = router;
