import { test } from 'node:test';
import assert from 'node:assert/strict';

const values = new Map([['openwa_api_key', 'test-api-key']]);
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  },
});

const requests: Array<{ url: string; init: RequestInit }> = [];
const call = {
  id: 'call/1',
  peerId: '15551234567@c.us',
  direction: 'outgoing',
  state: 'ringing',
  media: 'audio',
  muted: false,
  createdAt: '2026-07-13T12:00:00.000Z',
  canAccept: false,
  canReject: false,
};

globalThis.fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
  requests.push({ url: String(input), init });
  const url = String(input);
  const isAction = /\/(accept|reject|end|mute)$/.test(url);
  const body = isAction
    ? { success: true }
    : url.endsWith('/calls') && (init.method ?? 'GET') === 'GET'
      ? [call]
      : call;
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const { callApi } = await import('./api.ts');

test('callApi uses every call REST route with authentication and typed payloads', async () => {
  await callApi.list('session-1');
  await callApi.create('session-1', { peerId: '15551234567@c.us' });
  await callApi.get('session-1', 'call/1');
  await callApi.accept('session-1', 'call/1');
  await callApi.reject('session-1', 'call/1');
  await callApi.end('session-1', 'call/1');
  await callApi.mute('session-1', 'call/1', true);

  assert.deepEqual(
    requests.map(({ url, init }) => [init.method ?? 'GET', url]),
    [
      ['GET', '/api/sessions/session-1/calls'],
      ['POST', '/api/sessions/session-1/calls'],
      ['GET', '/api/sessions/session-1/calls/call%2F1'],
      ['POST', '/api/sessions/session-1/calls/call%2F1/accept'],
      ['POST', '/api/sessions/session-1/calls/call%2F1/reject'],
      ['POST', '/api/sessions/session-1/calls/call%2F1/end'],
      ['PATCH', '/api/sessions/session-1/calls/call%2F1/mute'],
    ],
  );
  assert.deepEqual(JSON.parse(String(requests[1].init.body)), { peerId: '15551234567@c.us' });
  assert.deepEqual(JSON.parse(String(requests[4].init.body)), {});
  assert.deepEqual(JSON.parse(String(requests[5].init.body)), {});
  assert.deepEqual(JSON.parse(String(requests[6].init.body)), { muted: true });

  for (const request of requests) {
    assert.equal(new Headers(request.init.headers).get('X-API-Key'), 'test-api-key');
  }
});
