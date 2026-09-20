import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
const school = { id: 'example', name: 'Example University', domain: 'example.edu', considering: true, departments: ['CS'], sources: [], notes: 'private school note' };
const sourceUrl = 'https://example.edu/cs/jobs';
const applicationUrl = 'https://apply.interfolio.com/12345';
const finding = { schoolId: school.id, sourceRequestId: null, department: 'CS', title: 'Faculty search', sourceUrl, applicationUrl, deadline: null, deadlineType: null, deadlineText: null, hardDeadline: null, rank: null, areas: null, materials: null, letters: null, summary: 'Current faculty hiring.', hiringStatus: 'Open' };

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
  let calls = [], handler = async () => Response.json({ id: 'resp_fixture', status: 'queued' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(url, /^https:\/\/api\.openai\.com\/v1\/responses(?:\/resp_[\w-]+)?$/);
    assert.equal(init.headers.Authorization, 'Bearer fixture-key-not-real');
    const call = { url, method: init.method, body: init.body && JSON.parse(init.body) }; calls.push(call);
    return handler(call);
  };
  t.after(() => { globalThis.fetch = originalFetch; sql.close(); });
  return { add: load(resolve(root, 'lib/add-source.ts')).addSource, api: load(resolve(root, 'lib/research.ts')), result: load(resolve(root, 'lib/research-result.ts')), env, hooks, put, get, count, records, calls, respond: fn => { handler = fn; } };
}

function complete(openings = [finding], extra = {}, evidence = [sourceUrl, applicationUrl]) {
  const result = { summary: 'Checked current official sources.', checkedSchoolIds: [school.id], completedRequestIds: [], inspectedUrls: evidence, gaps: [], openings, ...extra };
  return Response.json({ status: 'completed', output: [
    { type: 'web_search_call', action: { type: 'search', sources: evidence.map(url => ({ url })) } },
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(result) }] },
  ] });
}

test('missing API key never starts a paid request', async t => {
  const h = harness(t); delete h.env.OPENAI_API_KEY;
  await assert.rejects(h.api.startResearch('all'), /No search has started/);
  assert.equal(h.calls.length, 0); assert.equal(h.get('meta', 'research'), undefined);
});

test('concurrent clicks start one request; private notes are excluded', async t => {
  const h = harness(t);
  await Promise.all([h.api.startResearch('all'), h.api.startResearch('all')]);
  assert.equal(h.calls.length, 1); assert.equal(h.get('meta', 'research').status, 'running');
  assert.equal(JSON.stringify(h.calls[0].body).includes('private school note'), false);
});

test('concurrent polls import once and preserve notes edited during research', async t => {
  const h = harness(t);
  h.put('opening', 'existing', { ...finding, id: 'existing', applicationUrl: '', notes: 'older note', workflow: 'Considering', materials: 'CV required' });
  await h.api.startResearch('all');
  h.hooks.beforeBatch = () => h.put('opening', 'existing', { ...h.get('opening', 'existing'), notes: 'latest private note', workflow: 'Applied' });
  h.respond(() => complete());
  await Promise.all([h.api.pollResearch(), h.api.pollResearch()]);
  assert.equal(h.count('opening'), 1); assert.equal(h.count('run'), 1);
  const saved = h.get('opening', 'existing');
  assert.equal(saved.revision, 3); assert.equal(saved.notes, 'latest private note'); assert.equal(saved.workflow, 'Applied');
  assert.equal(saved.materials, 'CV required'); assert.equal(saved.applicationUrl, applicationUrl);
  assert.equal(h.get('meta', 'research').status, 'completed');
  await h.api.pollResearch(); assert.equal(h.count('run'), 1);
});

test('a failed storage batch rolls back all imports and can retry', async t => {
  const h = harness(t); await h.api.startResearch('all'); h.respond(() => complete()); h.hooks.failAt = 1;
  await assert.rejects(h.api.pollResearch(), /Injected storage failure/);
  assert.equal(h.count('opening'), 0); assert.equal(h.count('run'), 0); assert.equal(h.get('meta', 'research').status, 'running');
  h.hooks.failAt = -1; await h.api.pollResearch(); assert.equal(h.count('opening'), 1); assert.equal(h.count('run'), 1);
});

test('expired results release the run; transient provider errors preserve it', async t => {
  const h = harness(t); await h.api.startResearch('all');
  h.respond(() => new Response('', { status: 503 })); await assert.rejects(h.api.pollResearch(), /503/);
  assert.equal(h.get('meta', 'research').status, 'running');
  h.respond(() => new Response('', { status: 404 })); await h.api.pollResearch(); assert.equal(h.get('meta', 'research').status, 'failed');
  h.respond(() => Response.json({ id: 'resp_retry', status: 'queued' })); await h.api.startResearch('all');
  h.respond(() => new Response('', { status: 410 })); await h.api.pollResearch(); assert.equal(h.get('meta', 'research').status, 'failed');
});

test('incomplete and refused responses never import findings', async t => {
  const h = harness(t);
  for (const response of [{ status: 'incomplete' }, { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal' }] }] }]) {
    h.respond(() => Response.json({ id: 'resp_fixture', status: 'queued' })); await h.api.startResearch('all');
    h.respond(() => Response.json(response)); await h.api.pollResearch(); assert.equal(h.get('meta', 'research').status, 'failed');
  }
  assert.equal(h.count('opening'), 0); assert.equal(h.count('run'), 0);
});

test('unproven application URLs are omitted; unofficial sources are excluded', async t => {
  const h = harness(t); await h.api.startResearch('all');
  h.respond(() => complete([finding, { ...finding, title: 'Untrusted role', sourceUrl: 'https://untrusted.example/job' }], {}, [sourceUrl, 'https://untrusted.example/job']));
  await h.api.pollResearch(); assert.equal(h.count('opening'), 1);
  assert.equal(h.records('opening')[0].applicationUrl, '');
  const job = h.get('meta', 'research'); assert.equal(job.added, 1); assert.ok(job.gaps >= 2);
  assert.equal(h.result.openingPatch({ ...finding, sourceRequestId: 'queued' }, '2026-01-01').sourceRequestId, undefined);
});

test('queued portal links can resolve a school outside the shortlist', async t => {
  const h = harness(t);
  h.put('school', 'other', { ...school, id: 'other', name: 'Other University', considering: false });
  h.put('request', 'link', { id: 'link', url: applicationUrl, status: 'Queued' });
  await h.api.startResearch('considering');
  const input = JSON.parse(h.calls[0].body.input); assert.equal(input.schoolsToSearch.length, 1); assert.equal(input.directoryForQueuedLinks.length, 2);
  h.respond(() => complete([{ ...finding, schoolId: 'other', sourceRequestId: 'link' }], { completedRequestIds: ['link'] }));
  await h.api.pollResearch(); assert.equal(h.count('opening'), 1); assert.equal(h.get('request', 'link').status, 'Researched');
});

test('adding a link immediately starts focused analysis, including during a broad search', async t => {
  const h = harness(t); await h.api.startResearch('all');
  const broad = h.get('meta', 'research');
  const added = await h.add(sourceUrl);
  assert.equal(added.analysis.status, 'running'); assert.equal(h.calls.length, 2);
  const input = JSON.parse(h.calls[1].body.input);
  assert.deepEqual(input.queuedLinks.map(r => r.url), [sourceUrl]);
  assert.match(h.calls[1].body.instructions, /Analyze only the supplied queued link/);
  assert.equal(h.calls[1].body.max_tool_calls, 25);
  assert.equal(h.get('meta', 'research').id, broad.id);
  const linkId = added.request.id;
  h.respond(() => complete([{ ...finding, sourceRequestId: linkId }], { completedRequestIds: [linkId] }));
  await h.api.pollResearch('research-link-' + linkId);
  assert.equal(h.get('request', linkId).status, 'Researched');
  assert.equal(h.get('meta', 'research').status, 'running');
  assert.equal(h.get('opening', 'intake-' + linkId).workflow, 'Archived');
  const state = await h.api.researchStatus(); assert.equal(state.links[0].status, 'completed');
});

test('duplicate link submissions share one paid analysis and never overwrite notes', async t => {
  const h = harness(t);
  const [first, second] = await Promise.all([h.add(sourceUrl), h.add(sourceUrl)]);
  assert.equal(h.calls.length, 1); assert.equal(first.request.id, second.request.id); assert.equal(h.count('request'), 1); assert.equal(h.count('opening'), 1);
  const draftId = 'intake-' + first.request.id;
  h.put('opening', draftId, { ...h.get('opening', draftId), notes: 'My notes', workflow: 'Preparing' });
  await h.add(sourceUrl); assert.equal(h.calls.length, 1);
  assert.equal(h.get('opening', draftId).notes, 'My notes'); assert.equal(h.get('opening', draftId).workflow, 'Preparing');
});

test('a missing key or provider failure saves the link without pretending analysis ran', async t => {
  const h = harness(t); delete h.env.OPENAI_API_KEY;
  const saved = await h.add(sourceUrl); assert.equal(saved.analysis.status, 'setup_needed'); assert.equal(h.count('request'), 1); assert.equal(h.calls.length, 0);
  h.env.OPENAI_API_KEY = 'fixture-key-not-real'; h.respond(() => new Response('', { status: 429 }));
  const failed = await h.add(sourceUrl); assert.equal(failed.analysis.status, 'failed'); assert.equal(h.count('request'), 1);
  const calls = h.calls.length; await h.add(sourceUrl); assert.equal(h.calls.length, calls, 'A repeated add must not retry a failed paid attempt');
  h.respond(() => Response.json({ id: 'resp_retry', status: 'queued' }));
  await h.api.startResearch('link', saved.request.id, true); assert.equal(h.calls.length, calls + 1);
});

test('finished links do not restart; partial link analysis requires an explicit retry', async t => {
  const h = harness(t); const saved = await h.add(sourceUrl); const id = saved.request.id;
  h.respond(() => complete([], { checkedSchoolIds: [], completedRequestIds: [], gaps: ['Source blocked'] }, []));
  await h.api.pollAllResearch(); assert.equal(h.get('meta', 'research-link-' + id).needsRetry, true);
  const calls = h.calls.length; await h.add(sourceUrl); assert.equal(h.calls.length, calls);
  h.respond(() => Response.json({ id: 'resp_retry', status: 'queued' })); await h.api.startResearch('link', id, true);
  h.respond(() => complete([], { completedRequestIds: [id], summary: 'No current openings.' }, [sourceUrl]));
  await h.api.pollAllResearch(); assert.equal(h.get('request', id).status, 'Researched');
  const finishedCalls = h.calls.length; await h.add(sourceUrl); assert.equal(h.calls.length, finishedCalls);
});

test('link completion can update the saved draft without archiving the analyzed opening', async t => {
  const h = harness(t); const saved = await h.add(sourceUrl); const id = saved.request.id;
  const draft = h.get('opening', 'intake-' + id);
  h.respond(() => complete([{ ...finding, title: draft.title, sourceRequestId: id }], { completedRequestIds: [id] }));
  await h.api.pollAllResearch();
  assert.equal(h.count('opening'), 1); assert.equal(h.get('opening', draft.id).workflow, 'Inbox');
  assert.equal(h.get('opening', draft.id).applicationUrl, applicationUrl);
});

test('adding a link already included in an active broad search reuses that search', async t => {
  const h = harness(t); delete h.env.OPENAI_API_KEY;
  const saved = await h.add(sourceUrl); h.env.OPENAI_API_KEY = 'fixture-key-not-real';
  await h.api.startResearch('all'); const again = await h.add(sourceUrl);
  assert.equal(h.calls.length, 1); assert.equal(again.analysis.status, 'running');
  assert.ok(again.analysis.requestIds.includes(saved.request.id));
  assert.equal(h.get('meta', 'research-link-' + saved.request.id), undefined);
});
