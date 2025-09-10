// middlewares/diag.js
'use strict';

const onFinished = require('on-finished');

module.exports = function diag() {
  return function(req, res, next) {
    const start = process.hrtime.bigint();
    let stage = 'start';

    // propagate client abort to downstream fetch/SDKs
    const clientAbort = new AbortController();
    req.clientAbortSignal = clientAbort.signal;
    const abort = () => clientAbort.abort();
    req.on('aborted', abort);
    req.on('close', abort);

    // tiny helpers
    const mark = (name) => {
      stage = name;
      const now = Number(process.hrtime.bigint() - start) / 1e6;
      const prev = res.getHeader('Server-Timing');
      const val = `${prev ? String(prev)+',' : ''}${name};dur=${now.toFixed(1)}`;
      res.setHeader('Server-Timing', val);
    };
    res.locals._mark = mark;

    // log on finish
    onFinished(res, () => {
      const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
      const status = res.statusCode;
      console.log(
        `[diag] ${req.method} ${req.originalUrl} → ${status} | ${totalMs.toFixed(1)}ms | last:${stage} | ip:${req.ip}`
      );
    });

    mark('recv'); // body received (post-parsers)
    next();
  };
};
