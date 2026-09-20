import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const module = { exports: {} };
const js = ts.transpileModule(readFileSync(new URL('../build/sites-vite-plugin.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', js)(createRequire(import.meta.url), module, module.exports);

function request({ localOnly = true, host = '127.0.0.1:5173', address = '127.0.0.1', headers = {}, path = '/api/desk' } = {}) {
  let middleware;
  module.exports.sites({ localOnly }).configureServer({
    config: { server: {}, logger: { info() {} } },
    middlewares: { use(handler) { middleware = handler; } },
  });
  const req = { method: 'GET', url: path, socket: { remoteAddress: address }, headers: { host, ...headers } };
  req.rawHeaders = Object.entries(req.headers).flat();
  const res = { statusCode: 200, setHeader() {}, end() { this.ended = true; } };
  let next = false;
  middleware(req, res, () => { next = true; });
  return { req, res, next };
}

test('local mode opens without a cookie and replaces forged identity headers', () => {
  const r = request({ headers: { 'oai-authenticated-user-id': 'forged' } });
  assert.equal(r.next, true);
  assert.equal(r.req.headers['oai-authenticated-user-id'], 'local_seedy');
  assert.equal(r.req.rawHeaders.includes('forged'), false);
});

test('local API rejects remote hosts, remote sockets, absolute remote URLs and cross-origin access', () => {
  for (const input of [
    { host: 'attacker.example' }, { address: '192.168.1.10' },
    { path: 'https://attacker.example/api/desk' },
    { headers: { origin: 'https://attacker.example' } },
    { headers: { 'sec-fetch-site': 'cross-site' } },
  ]) {
    const r = request(input);
    assert.equal(r.res.statusCode, 403);
    assert.equal(r.next, false);
    assert.equal(r.req.headers['oai-authenticated-user-id'], undefined);
  }
});

test('ordinary preview mode still requires its local sign-in cookie', () => {
  const anonymous = request({ localOnly: false, headers: { 'oai-authenticated-user-id': 'forged' } });
  assert.equal(anonymous.req.headers['oai-authenticated-user-id'], undefined);
  const signedIn = request({ localOnly: false, headers: { cookie: '__sites_local_auth=1' } });
  assert.equal(signedIn.req.headers['oai-authenticated-user-id'], 'local_seedy');
});
