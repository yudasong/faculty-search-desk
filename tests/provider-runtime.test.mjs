import '../scripts/sites-env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, createFetchMock } from 'miniflare';
import ts from 'typescript';

const provider = ts.transpileModule(readFileSync(new URL('../lib/openai-provider.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

async function runtime(t, outboundService) {
  const mock = createFetchMock(); mock.disableNetConnect();
  const worker = new Miniflare({
    modules: true, compatibilityDate: '2026-05-01', ...(outboundService ? { outboundService } : { fetchMock: mock }),
    script: provider + `
      export default { async fetch(request) {
        try {
          const poll = new URL(request.url).pathname === '/poll';
          return Response.json(await openAIResponse(poll ? '/resp_fixture' : '', poll ? undefined : {model:'fixture',input:'fixture'}, 'sk-fixture-never-a-real-key'));
        } catch(e) { return Response.json({error:e.message,status:e.status ?? null}); }
      } };`,
  });
  t.after(async () => { await worker.dispose(); await mock.close(); });
  return { mock, call: async (path = '/') => (await worker.dispatchFetch('http://localhost' + path)).json() };
}

test('real Worker runtime can construct and send research starts and status requests', async t => {
  const h = await runtime(t);
  const provider = h.mock.get('https://api.openai.com');
  provider.intercept({ path: '/v1/responses', method: 'POST' }).reply(200, { id: 'resp_fixture', status: 'queued' });
  provider.intercept({ path: '/v1/responses/resp_fixture', method: 'GET' }).reply(200, { id: 'resp_fixture', status: 'completed' });
  assert.deepEqual(await h.call(), { id: 'resp_fixture', status: 'queued' });
  assert.equal((await h.call('/poll')).status, 'completed');
  h.mock.assertNoPendingInterceptors();
});

test('Worker redirects are blocked without forwarding credentials', async t => {
  let forwarded = 0, calls = 0;
  const h = await runtime(t, request => {
    calls++;
    if (new URL(request.url).hostname !== 'api.openai.com') {
      forwarded++; return Response.json({});
    }
    return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example/collect' } });
  });
  const result = await h.call();
  assert.match(result.error, /unexpected redirect/);
  assert.equal(result.status, 307); assert.equal(forwarded, 0); assert.equal(calls, 1);
});

test('billing failures are distinct from rate limits and never echo provider secrets', async t => {
  const h = await runtime(t);
  const provider = h.mock.get('https://api.openai.com');
  for (const code of ['insufficient_quota', 'rate_limit_exceeded']) {
    provider.intercept({ path: '/v1/responses', method: 'POST' })
      .reply(429, { error: { code, message: 'sk-secret-provider-message-must-not-be-shown' } });
  }
  const billing = await h.call(), limited = await h.call();
  assert.match(billing.error, /credits or spending quota are exhausted/);
  assert.match(limited.error, /rate or usage limit reached/);
  assert.equal(JSON.stringify([billing, limited]).includes('sk-secret'), false);
});
