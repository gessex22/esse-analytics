// Diagnóstico opt-in de los endpoints JSON de backup. No usar para videos o
// streams: se consume el cuerpo completo antes de devolver la respuesta.
// Los bytes recibidos son descomprimidos; no representan tráfico facturable.
export async function fetchBackupWithMetrics(url: string, init?: RequestInit): Promise<Response> {
  if (process.env.ESSE_SYNC_METRICS !== '1') return fetch(url, init);

  const started = performance.now();
  const metric = {
    event: 'backup_http',
    at: new Date().toISOString(),
    method: init?.method ?? 'GET',
    path: new URL(url).pathname,
    sentJsonBytes: typeof init?.body === 'string' ? Buffer.byteLength(init.body, 'utf8') : 0,
  };
  try {
    const response = await fetch(url, init);
    const bytes = await response.arrayBuffer();
    console.info('[sync-metrics]', JSON.stringify({
      ...metric, status: response.status, ok: response.ok,
      receivedDecodedBytes: bytes.byteLength,
      downloadMs: Math.round(performance.now() - started),
    }));
    // Conserva status/headers y un cuerpo consumible por los callers existentes.
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  } catch (error) {
    // No registrar mensajes de excepciones: podrían incluir URLs o contenido.
    console.info('[sync-metrics]', JSON.stringify({
      ...metric, ok: false, downloadMs: Math.round(performance.now() - started),
      failure: 'transport_or_body',
    }));
    throw error;
  }
}

export function recordSyncMetric(event: string, values: Record<string, number>): void {
  if (process.env.ESSE_SYNC_METRICS !== '1') return;
  console.info('[sync-metrics]', JSON.stringify({ event, at: new Date().toISOString(), ...values }));
}
