import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchBackupWithMetrics } from './sync-metrics.service';

test('diagnóstico conserva respuestas y mide UTF-8 sin exponer datos privados', async () => {
  const originalFetch = globalThis.fetch;
  const originalInfo = console.info;
  const originalFlag = process.env.ESSE_SYNC_METRICS;
  const logs: string[] = [];
  console.info = (...args) => { logs.push(args.join(' ')); };
  process.env.ESSE_SYNC_METRICS = '1';
  try {
    const body = JSON.stringify({ title: 'privado-á' });
    globalThis.fetch = async () => new Response(body, { status: 200 });
    const response = await fetchBackupWithMetrics('https://example.com/api/backup/files?secret=oculto', {
      method: 'POST', headers: { Authorization: 'Bearer secreto' }, body,
    });
    assert.deepEqual(await response.json(), JSON.parse(body));
    const metric = JSON.parse(logs[0].slice('[sync-metrics] '.length));
    assert.equal(metric.receivedDecodedBytes, Buffer.byteLength(body));
    assert.equal(metric.sentJsonBytes, Buffer.byteLength(body));
    assert.equal(metric.path, '/api/backup/files');
    assert.doesNotMatch(logs.join(''), /privado|secreto|oculto/);

    globalThis.fetch = async () => new Response('{"error":"denegado"}', { status: 403 });
    const denied = await fetchBackupWithMetrics('https://example.com/api/backup/files');
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'denegado' });

    globalThis.fetch = async () => new Response(null, { status: 204 });
    assert.equal((await fetchBackupWithMetrics('https://example.com/api/backup/files')).status, 204);

    const failure = new Error('secreto');
    globalThis.fetch = async () => { throw failure; };
    await assert.rejects(fetchBackupWithMetrics('https://example.com/api/backup/files'), error => error === failure);
    assert.doesNotMatch(logs.join(''), /secreto/);

    process.env.ESSE_SYNC_METRICS = '0';
    const untouched = new Response('{}');
    globalThis.fetch = async () => untouched;
    const count = logs.length;
    assert.equal(await fetchBackupWithMetrics('https://example.com/api/backup/files'), untouched);
    assert.equal(logs.length, count);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalInfo;
    if (originalFlag === undefined) delete process.env.ESSE_SYNC_METRICS;
    else process.env.ESSE_SYNC_METRICS = originalFlag;
  }
});
