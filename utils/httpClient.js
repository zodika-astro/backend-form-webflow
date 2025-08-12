// utils/httpClient.js

const fetch = require('node-fetch');

async function request(url, options = {}) {
  const res = await fetch(url, options);

  if (!res.ok) {
    const text = await res.text();
    // Lança um erro detalhado que pode ser capturado
    throw new Error(`HTTP ${res.status} - ${text}`);
  }

  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return res.json();
  }

  return res.text();
}

// Atalhos para verbos comuns, usando a função `request`
module.exports = {
  get: (url, options) => request(url, { ...options, method: 'GET' }),

  post: (url, body, options) =>
    request(url, {
      ...options,
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {})
      }
    }),

  put: (url, body, options) =>
    request(url, {
      ...options,
      method: 'PUT',
      body: JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(options?.headers || {})
      }
    }),

  delete: (url, options) => request(url, { ...options, method: 'DELETE' })
};
