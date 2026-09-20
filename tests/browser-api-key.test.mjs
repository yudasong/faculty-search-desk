import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const key = 'sk-test-browser-storage-fixture';
function setup() {
  const values = new Map(), calls = [];
  const window = new EventTarget();
  window.localStorage = { getItem: name => values.get(name) || null, setItem: (name, value) => values.set(name, value), removeItem: name => values.delete(name) };
  const load = name => {
    const js = ts.transpileModule(readFileSync(new URL('../lib/' + name + '.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    new Function('module', 'exports', 'window', 'fetch', js)(module, module.exports, window, (url, init) => { calls.push({ url, init }); return Promise.resolve(Response.json({})); });
    return module.exports;
  };
  return { api: load('browser-api-key'), parse: load('request-api-key').requestApiKey, window, calls, values };
}

test('save, replace, and forget update only local browser storage', async () => {
  const h = setup(); let changes = 0;
  h.window.addEventListener(h.api.keyChangedEvent, () => changes++);
  h.api.saveBrowserApiKey(key); assert.equal(h.api.browserApiKey(), key); assert.equal(h.calls.length, 0);
  await h.api.researchFetch('/api/research', { method: 'POST', body: '{"action":"poll"}' });
  assert.equal(h.calls[0].init.headers.get('X-OpenAI-API-Key'), key);
  assert.equal(h.calls[0].init.redirect, 'error'); assert.equal(h.calls[0].init.credentials, 'same-origin');
  assert.equal(h.calls[0].url.includes(key), false); assert.equal(h.calls[0].init.body.includes(key), false);
  assert.equal(h.parse(new Request('https://example.test/api/research', { headers: h.calls[0].init.headers })), key);
  h.api.forgetBrowserApiKey(); assert.equal(h.api.browserApiKey(), ''); assert.equal(changes, 2);
  await h.api.researchFetch('/api/research'); assert.equal(h.calls[1].init.headers.has('X-OpenAI-API-Key'), false);
});

test('local storage errors are visible and never claim the key was saved', () => {
  const h = setup(); h.window.localStorage.setItem = () => { throw new Error('Storage blocked'); };
  assert.throws(() => h.api.saveBrowserApiKey(key), /browser blocked local storage/);
  assert.equal(h.api.browserApiKey(), ''); assert.equal(h.calls.length, 0);
});

test('credentials cannot be sent to external URLs or reflected in validation errors', () => {
  const h = setup(); h.api.saveBrowserApiKey(key);
  assert.throws(() => h.api.researchFetch('https://external.example/api/research'), /Invalid research endpoint/);
  const invalid = 'private-value-that-is-not-a-key';
  for (const attempt of [() => h.api.saveBrowserApiKey(invalid), () => h.parse(new Request('https://example.test', { headers: { 'X-OpenAI-API-Key': invalid } }))]) {
    assert.throws(attempt, error => !error.message.includes(invalid));
  }
  assert.equal(h.calls.length, 0);
});
