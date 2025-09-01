// utils/httpClient.js (sem dependências externas)
const DEFAULT_TIMEOUT = 20000;

// Base para PagBank (MP usa URL absoluta no service)
let BASE_URL = process.env.PAGBANK_BASE_URL || '';
if (BASE_URL.endsWith('/')) BASE_URL = BASE_URL.slice(0, -1);

function isAbsolute(url = '') {
  return /^https?:\/\//i.test(url);
}

async function request(method, url, { headers = {}, data, timeout = DEFAULT_TIMEOUT } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  const finalUrl = isAbsolute(url) ? url : `${BASE_URL}${url}`;

  const baseHeaders = { Accept: 'application/json', ...headers };
  if (data !== undefined && baseHeaders['Content-Type'] == null) {
    baseHeaders['Content-Type'] = 'application/json';
  }

  try {
    const res = await fetch(finalUrl, {
      method,
      headers: baseHeaders,
      body: data !== undefined ? JSON.stringify(data) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; }
    catch { json = { raw: text }; }

    if (!res.ok) {
      const error = new Error(`HTTP ${res.status} on ${finalUrl}`);
      error.response = {
        status: res.status,
        data: json,
        headers: Object.fromEntries(res.headers.entries()),
      };
      error.config = { url: finalUrl, method, data, headers: baseHeaders };
      throw error;
    }

    return {
      status: res.status,
      data: json,
      headers: Object.fromEntries(res.headers.entries()),
      config: { url: finalUrl, method, data, headers: baseHeaders },
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
