// payments/payPal/controller.js
'use strict';

const paypalService         = require('./service');
const birthchartRepository  = require('../../modules/birthchart/repository');
const AppError              = require('../../utils/appError');
const baseLogger            = require('../../utils/logger').child('payments.paypal.controller');
const orchestrator          = require('../../payments/orchestrator');

/**
 * Utility: echo a stable request id back to clients/proxies.
 */
function echoRequestId(req, res) {
  const rid =
    req.requestId ||
    req.get?.('x-request-id') ||
    req.get?.('x-correlation-id');

  if (rid) res.set('X-Request-Id', String(rid));
  return rid;
}

/**
 * POST /paypal/checkout
 * Creates a PayPal order for the given request/product.
 *
 * Expected body fields (mirroring MP as much as possible):
 *  - requestId   (required)
 *  - name        (optional, payer name)
 *  - email       (optional, payer email)
 *  - productType (required, e.g. "birth_chart")
 *  - productValue (required, integer cents)
 *  - productName  (optional, human-readable name)
 *  - paymentOptions (optional, mirrors MP structure)
 *  - currency      (optional, default "BRL")
 */
async function createCheckout(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('createCheckout', { rid });

  try {
    const {
      requestId,
      name,
      email,
      productType,
      productValue,
      productName,
      paymentOptions,
      currency,
    } = req.body || {};

    if (!requestId || !productType || !productValue) {
      log.warn({ reason: 'missing_fields' }, 'invalid request');
      return res.status(400).json({
        error: 'invalid_request',
        details: 'requestId, productType and productValue are required.',
      });
    }

    const result = await paypalService.createCheckout(
      {
        requestId,
        name,
        email,
        productType,
        productValue,
        productName,
        paymentOptions,
        currency,
      },
      { requestId: rid, log }
    );

    // Convention: service should return { orderId, approvalUrl? }
    return res.status(201).json({
      orderId: result.orderId,
      approvalUrl: result.approvalUrl || null,
    });
  } catch (err) {
    const wrapped =
      err instanceof AppError
        ? err
        : AppError.wrap(err, 'paypal_checkout_failed');

    (req.log || baseLogger).logError(err, {
      where: 'paypal.controller.createCheckout',
      code: wrapped.code,
      status: wrapped.status,
    });

    return res.status(wrapped.status || 500).json({
      error: wrapped.code || 'paypal_checkout_failed',
      details: { context: 'paypal', status: wrapped.status || 500 },
    });
  }
}

/**
 * POST /paypal/capture
 * Captures an approved PayPal order (called from frontend after onApprove).
 *
 * Expected body fields:
 *  - orderId   (required)  – PayPal order id returned on checkout
 *  - requestId (optional)  – internal request id for extra safety
 *
 * Behavior:
 *  - Delegates capture to service (PayPal Orders API).
 *  - Lets service update internal records / orchestrator as needed.
 *  - Returns minimal normalized payload for frontend.
 */
async function captureOrder(req, res) {
  const rid = echoRequestId(req, res);
  const log = (req.log || baseLogger).child('captureOrder', { rid });

  try {
    const { orderId, orderID, requestId } = req.body || {};
    const finalOrderId = orderId || orderID;

    if (!finalOrderId) {
      log.warn({ reason: 'missing_order_id' }, 'invalid capture request');
      return res.status(400).json({
        error: 'invalid_request',
        details: 'orderId is required.',
      });
    }

    const capture = await paypalService.captureOrder(
      {
        orderId: finalOrderId,
        requestId: requestId || null,
      },
      { requestId: rid, log }
    );

    // capture is expected to be the decoded PayPal order/capture response
    return res.status(200).json({
      status: capture.status,
      paypalOrderId: capture.id,
      raw: capture,
    });
  } catch (err) {
    const wrapped =
      err instanceof AppError
        ? err
        : AppError.wrap(err, 'paypal_capture_failed');

    (req.log || baseLogger).logError(err, {
      where: 'paypal.controller.captureOrder',
      code: wrapped.code,
      status: wrapped.status,
    });

    return res.status(wrapped.status || 500).json({
      error: wrapped.code || 'paypal_capture_failed',
      details: { context: 'paypal', status: wrapped.status || 500 },
    });
  }
}

// --- SSE hub (in-memory) + bridge to orchestrator (same pattern as MP) ------
const sseHub = {
  channels: new Map(),
  add(requestId, res) {
    const k = String(requestId);
    if (!this.channels.has(k)) this.channels.set(k, new Set());
    this.channels.get(k).add(res);
  },
  remove(requestId, res) {
    const k = String(requestId);
    const set = this.channels.get(k);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.channels.delete(k);
  },
  broadcast(requestId, payload) {
    const set = this.channels.get(String(requestId));
    if (!set || set.size === 0) return 0;
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try {
        res.write(data);
      } catch {
        // ignore broken pipes
      }
    }
    return set.size;
  },
};

/** GET /paypal/status?request_id=...  (safety polling) */
async function getPaymentStatus(req, res) {
  echoRequestId(req, res);
  try {
    const requestId = req.query.request_id || req.query.requestId;
    if (!requestId) {
      return res.status(400).json({ error: 'missing_request_id' });
    }

    const r = await birthchartRepository.findByRequestId(requestId);
    if (!r) return res.status(404).json({ error: 'not_found' });

    return res.json({
      requestId: r.request_id,
      status: r.payment_status,
      statusDetail: r.payment_status_detail,
      updatedAt: r.payment_updated_at || r.updated_at,
    });
  } catch {
    return res.status(500).json({ error: 'status_lookup_failed' });
  }
}

/** GET /paypal/stream?request_id=...  (SSE in real time) */
async function streamStatus(req, res) {
  echoRequestId(req, res);
  const requestId = req.query.request_id || req.query.requestId;
  if (!requestId) return res.status(400).end();

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      // ignore
    }
  }, 25_000);

  try {
    const r = await birthchartRepository.findByRequestId(requestId);
    if (r) {
      res.write(
        `data: ${JSON.stringify({
          requestId: r.request_id,
          status: r.payment_status,
          statusDetail: r.payment_status_detail,
          updatedAt: r.payment_updated_at || r.updated_at,
        })}\n\n`
      );
    }
  } catch {
    // best-effort only
  }

  sseHub.add(requestId, res);
  req.on('close', () => {
    clearInterval(keepalive);
    sseHub.remove(requestId, res);
    try {
      res.end();
    } catch {
      // ignore
    }
  });
}

/**
 * Bridge orchestrator → SSE hub
 * Reutiliza o mesmo evento genérico "payments:status-changed".
 * O front escolhe consumir via /mercadoPago/stream ou /paypal/stream
 * dependendo do provedor utilizado.
 */
orchestrator.events.on('payments:status-changed', (evt) => {
  if (!evt?.requestId || evt?.productType !== 'birth_chart') return;
  sseHub.broadcast(evt.requestId, {
    requestId: evt.requestId,
    status: evt.normalizedStatus,
    provider: evt.provider || null,
    ts: new Date().toISOString(),
  });
});

module.exports = {
  createCheckout,
  captureOrder,
  getPaymentStatus,
  streamStatus,
};
