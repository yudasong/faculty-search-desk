import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => id.startsWith('.') ? load(resolve(dirname(file), id + '.ts')) : require(id), module, module.exports);
  return module.exports;
}
const { calendarDate, parseInterfolio, readResearchSource } = load(resolve(root, 'lib/research-source.ts'));
const url = 'https://apply.interfolio.com/189576';
const data = { position_id: 189576, landing_page_url: url, institution: 'Carnegie Mellon University: School of Computer Science', position_name: 'Faculty Positions: All Tracks 2027', start_date: 'Aug 10, 2026', end_date: 'Dec 16, 2026', active_status: 'Open', landing_page_description: 'Faculty opportunities across computer science. The teaching track has a separate early review date in October. This posting also includes research and tenure-track positions.' };

test('portal metadata preserves exact posting, deadline year, and local date', () => {
  const parsed = parseInterfolio(data, url);
  assert.equal(parsed.postingId, '189576'); assert.equal(parsed.closingDate, '2026-12-16');
  assert.equal(parsed.openDate, '2026-08-10');
  assert.equal(parsed.closingText, 'Deadline: Dec 16, 2026 at 11:59 PM Eastern Time');
  assert.equal(calendarDate('2026-12-16T23:59:00-05:00'), '2026-12-16');
  assert.equal(calendarDate('Feb 30, 2026'), undefined);
  assert.throws(() => parseInterfolio({ ...data, position_id: 189577 }, url), /different posting/);
  assert.throws(() => parseInterfolio({ ...data, landing_page_url: 'https://apply.interfolio.com/1' }, url), /different posting/);
  assert.throws(() => parseInterfolio({ ...data, private_flag: true }, url), /not public/);
});

test('the source reader uses the public portal endpoint without credentials', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (u, options) => {
    assert.equal(u, 'https://logic.interfolio.com/dossier-api/positions/189576');
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    return Response.json(data);
  };
  const document = await readResearchSource({ id: 'link', url });
  assert.equal(document.readable, true); assert.equal(document.complete, true);
  assert.match(document.text, /Deadline: Dec 16, 2026/);
});

test('unsupported redirects and oversized content cannot be used as verified evidence', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } }); };
  assert.equal((await readResearchSource({ id: 'link', url })).readable, false);
  assert.equal(calls, 1);
  globalThis.fetch = async () => new Response('x'.repeat(1000001), { headers: { 'content-type': 'text/html' } });
  assert.equal((await readResearchSource({ id: 'link', url })).readable, false);
});

test('metadata and late date passages survive a long HTML page, with truncation disclosed', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('<title>Faculty hiring</title><p>' + 'Faculty research. '.repeat(4500) + '</p><p>Deadline: December 16, 2026 at 11:59 PM Eastern</p><script type="application/ld+json">{"@type":"JobPosting","validThrough":"2026-12-16"}</script>', { headers: { 'content-type': 'text/html' } });
  const document = await readResearchSource({ id: 'long', url: 'https://example.edu/jobs' });
  assert.equal(document.readable, true); assert.equal(document.complete, false);
  assert.match(document.datePassages.join('\n'), /December 16, 2026/);
  assert.match(document.datePassages.join('\n'), /validThrough/);
});
