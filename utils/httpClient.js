const fetch = require('node-fetch');

// Função centralizada para fazer a requisição e tratar erros
async function request(url, options = {}) {
  const res = await fetch(url, options);

  // Se a resposta não for bem-sucedida (status 4xx ou 5xx),
  // lemos o corpo da resposta e lançamos um erro detalhado.
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} - ${text}`);
  }

  // Verificamos se a resposta é JSON para fazer o parse
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    try {
      return await res.json();
    } catch (e) {
      // Caso o parse do JSON falhe, lançamos um erro específico
      throw new Error(`Failed to parse JSON response: ${e.message}`);
    }
  }

  // Se não for JSON, retornamos o texto bruto
  return res.text();
}

// Exportamos helpers para cada método HTTP, garantindo que
// todos usem a função 'request' para o tratamento de erros.
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
