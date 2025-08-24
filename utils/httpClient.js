// utils/httpClient.js (sem dependências externas)
const DEFAULT_TIMEOUT = 20000;

// normaliza BASE_URL
let BASE_URL = process.env.PAGBANK_BASE_URL || '';
if (BASE_URL.endsWith('/')) {
  BASE_URL = BASE_URL.slice(0, -1);
}

async function request(method, url, { headers = {}, data, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${BASE_URL}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} on ${url}`);
      error.response = {
        status: res.status,
        data: json,
        headers: Object.fromEntries(res.headers.entries()),
      };
      error.config = { url, method, data, headers };
      throw error;
    }

    // compatível com axios-like
    return {
      status: res.status,
      data: json,
      headers: Object.fromEntries(res.headers.entries()),
      config: { url, method, data, headers },
    };
  } finally {
    clearTimeout(id);
  }
}

module.exports = {
  get: (url, opts) => request('GET', url, opts),
  post: (url, data, opts = {}) => request('POST', url, { ...opts, data }),
  put: (url, data, opts = {}) => request('PUT', url, { ...opts, data }),
  patch: (url, data, opts = {}) => request('PATCH', url, { ...opts, data }),
  delete: (url, opts) => request('DELETE', url, opts),
};
