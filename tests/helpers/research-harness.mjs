import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), '../..');
const school = { id: 'example', name: 'Example University', domain: 'example.edu', considering: true, departments: ['CS'], sources: [], notes: 'private school note' };
const sourceUrl = 'https://example.edu/cs/jobs';
const applicationUrl = 'https://apply.interfolio.com/12345';
const finding = { scopeEvidence: { area: 'CS', quote: 'computer science', reason: 'Computer science is the advertised hiring area.' }, schoolId: school.id, sourceRequestId: null, department: 'CS', title: 'Faculty search', sourceUrl, applicationUrl, deadline: null, deadlineType: null, deadlineText: null, hardDeadline: null, rank: null, areas: null, materials: null, letters: null, summary: 'Current faculty hiring.', hiringStatus: 'Open' };

function harness(t) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(readFileSync(resolve(root, 'drizzle/0000_small_hex.sql'), 'utf8'));
  const hooks = { beforeBatch: null, failAt: -1 };
  const prepare = (query, values = []) => ({
    bind: (...args) => prepare(query, args),
    first: async () => sql.prepare(query).get(...values) ?? null,
    all: async () => ({ results: sql.prepare(query).all(...values) }),
    run: async () => ({ meta: { changes: Number(sql.prepare(query).run(...values).changes) } }),
    execute: () => ({ meta: { changes: Number(sql.prepare(query).run(...values).changes) } }),
  });
  const env = { OPENAI_API_KEY: 'fixture-key-not-real', DB: { prepare, batch: async statements => {
    hooks.beforeBatch?.(); hooks.beforeBatch = null;
    sql.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s, i) => { if (i === hooks.failAt) throw new Error('Injected storage failure'); return s.execute(); });
      sql.exec('COMMIT'); return results;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const js = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    new Function('require', 'module', 'exports', js)(id => {
      if (id === 'cloudflare:workers') return { env };
      if (id === './seed') return { seed: { schools: [], openings: [], settings: {} } };
      return id.startsWith('.') ? load(resolve(dirname(file), id + '.ts')) : require(id);
    }, module, module.exports);
    return module.exports;
  }
  const put = (kind, id, value) => sql.prepare('INSERT INTO records VALUES(?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=records.revision+1').run(kind + ':' + id, kind, JSON.stringify(value), new Date().toISOString());
  const get = (kind, id) => { const row = sql.prepare('SELECT * FROM records WHERE id=?').get(kind + ':' + id); return row && { ...JSON.parse(row.data), revision: row.revision }; };
  const records = kind => sql.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.data));
  const count = kind => sql.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(kind).n;
  put('meta', 'initialized', {}); put('school', school.id, school); put('settings', 'main', { scope: 'Tenure-track faculty' });
  let sourceHandler = async url => url.startsWith('https://logic.interfolio.com/') ? Response.json({ position_id: 12345, landing_page_url: applicationUrl, position_name: 'Faculty search', institution: school.name, landing_page_description: 'Tenure-track faculty position across computer science. We welcome applications from candidates with a strong research and teaching record.', application_instructions: 'Submit a CV and research statement.', active_status: 'Open' }) : new Response('<title>Faculty search</title><p>Current faculty openings across computer science. Applications include a CV, research statement, teaching statement and letters of reference. See the linked official application portal for complete requirements and dates.</p>', { headers: { 'content-type': 'text/html' } });
  let calls = [], handler = async () => Response.json({ id: 'resp_fixture', status: 'queued' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.openai.com/')) { assert.equal(init.headers.Authorization, undefined); return sourceHandler(url, init); }
    assert.match(url, /^https:\/\/api\.openai\.com\/v1\/responses(?:\/resp_[\w-]+)?$/);
    assert.ok(init.headers.Authorization.startsWith('Bearer '));
    const call = { authorization: init.headers.Authorization, url, method: init.method, body: init.body && JSON.parse(init.body) }; calls.push(call);
    return handler(call);
  };
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  return { scope: load(resolve(root, 'lib/research-scope.ts')), workflow: load(resolve(root, 'lib/opening-workflow.ts')), sweep: load(resolve(root, 'lib/research-sweep.ts')), coverage: load(resolve(root, 'lib/research-coverage.ts')), add: load(resolve(root, 'lib/add-source.ts')).addSource, api: load(resolve(root, 'lib/research.ts')), result: load(resolve(root, 'lib/research-result.ts')), env, hooks, put, get, count, records, calls, sourceRespond: fn => { sourceHandler = fn; }, respond: fn => { handler = fn; } };
}

function complete(openings = [finding], extra = {}, evidence = [sourceUrl, applicationUrl]) {
  const result = { summary: 'Checked current official sources.', checkedSchoolIds: [school.id], completedRequestIds: [], inspectedUrls: evidence, gaps: [], openings, ...extra };
  return Response.json({ status: 'completed', output: [
    { type: 'web_search_call', action: { type: 'search', sources: evidence.map(url => ({ url })) } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
  ] });
}

export { harness, complete, school, sourceUrl, applicationUrl, finding };
