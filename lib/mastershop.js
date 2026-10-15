// Cliente mínimo de la API pública de Mastershop.
// La API key vive solo en el servidor (variable de entorno de Vercel).
const BASE_URL = "https://prod.api.mastershop.com";

export function tieneApiKey() {
  return Boolean(process.env.MASTERSHOP_API_KEY);
}

export async function mastershop(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      "ms-api-key": process.env.MASTERSHOP_API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
