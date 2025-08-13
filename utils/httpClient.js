// utils/httpClient.js
const axios = require('axios');

const http = axios.create({
  baseURL: process.env.PAGBANK_BASE_URL,
  timeout: 20000,
});

http.interceptors.request.use((cfg) => {
  const { Authorization, ...safeHeaders } = cfg.headers || {};
  console.log('[PagBank][REQ]', cfg.method?.toUpperCase(), cfg.url, {
    headers: safeHeaders,
    body: cfg.data,
  });
  return cfg;
});

http.interceptors.response.use(
  (res) => {
    console.log('[PagBank][RES]', res.status, res.config?.url, res.data);
    return res;
  },
  (err) => {
    if (err.response) {
      console.error('[PagBank][ERR]', err.response.status, err.config?.url, {
        data: err.response.data,
        headers: err.response.headers,
      });
    } else {
      console.error('[PagBank][ERR-NETWORK]', err.message);
    }
    throw err;
  }
);

module.exports = http;
