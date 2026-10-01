import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';
import { harvardHub, harvardPosting, harvardPage2, harvardSchool, harvardPages, page } from './fixtures/discovery.mjs';

const require = createRequire(import.meta.url);
const root = resolve(dirname(new URL(import.meta.url).pathname), '..');
function load(file) {
  const module = { exports: {} };
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)(id => id.startsWith('.') ? load(resolve(dirname(file), id + '.ts')) : require(id), module, module.exports);
  return module.exports;
}
const { discoverSchoolSources } = load(resolve(root, 'lib/research-discovery.ts'));
const { canonical } = load(resolve(root, 'lib/intake.ts'));
function mockPages(t, pages) {
  const saved = globalThis.fetch, calls = [];
  const normalized = new Map([...pages].map(([url, body]) => [canonical(url), body]));
  t.after(() => { globalThis.fetch = saved; });
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'manual');
    assert.deepEqual(Object.keys(options.headers), ['Accept']);
    const content = normalized.get(url);
    assert.ok(content !== undefined, `Unexpected source GET: ${url}`);
    return new Response(content, { headers: { 'content-type': 'text/html' } });
  };
  return calls;
}
function schoolAt(url, departments = ['CS']) {
  return { ...harvardSchool, id: 'example', domain: 'example.edu', departments, sources: [{ department: 'CS', url }] };
}

test('finds Harvard CS from only the saved hub, follows pagination, and reads full posting requirements', async t => {
  const calls = mockPages(t, harvardPages);
  assert.deepEqual(harvardSchool.sources.map(s => s.url), [harvardHub], 'the posting URL is not injected as an initial candidate');
  const result = await discoverSchoolSources(harvardSchool, []);
  assert.ok(calls.includes(harvardPosting), 'must GET the discovered posting, not merely see its anchor');
  assert.ok(calls.includes(canonical(harvardPage2)), 'pagination inside nav must be fetched');
  assert.ok(calls.includes('https://academicpositions.harvard.edu/postings/16841'), 'generic View Details remains a candidate');
  assert.equal(calls.some(url => /9000[01]|bookmarks|privacy|pre_apply/.test(url)), false, 'postdoc/fellow aliases, application forms, and utility links are excluded');
  const document = result.documents.find(d => d.url === harvardPosting);
  assert.equal(document.readable, true); assert.equal(document.complete, true);
  assert.match(document.text, /December 1, 2026/); assert.match(document.text, /three reference letters/);
  assert.match(document.text, /teaching statement/); assert.match(document.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(new Set(result.departments[0].sourceUrls), new Set(calls));
});

test('saved Harvard application forms do not create false gaps or replace advertisement reads', async t => {
  const calls = mockPages(t, harvardPages);
  const openings = ['/postings/16840/pre_apply', '/login', '/users/sign_in', '/applications/new', '/postings/16840/apply'].map((path, i) => ({
    id: String(i), schoolId: 'harvard', department: 'CS', workflow: 'Considering',
    sourceUrl: harvardPosting, applicationUrl: 'https://academicpositions.harvard.edu' + path,
  }));
  const result = await discoverSchoolSources(harvardSchool, openings);
  assert.deepEqual(result.issues, []);
  assert.equal(calls.filter(url => url === harvardPosting).length, 1);
  assert.equal(calls.some(url => /pre_apply|\/login|sign_in|applications\/new|\/apply$/.test(url)), false);
});

test('a saved source URL is still read and retained when it is itself an application form', async t => {
  const hub = 'https://example.edu/faculty-jobs', source = 'https://example.edu/postings/1/pre_apply';
  const calls = mockPages(t, new Map([[hub, page('Faculty openings')], [source, page('Application form')]]));
  const result = await discoverSchoolSources(schoolAt(hub), [{ id: '1', schoolId: 'example', department: 'CS', workflow: 'Considering', sourceUrl: source, applicationUrl: source }]);
  assert.ok(calls.includes(source));
  assert.ok(result.documents.some(d => d.url === source));
});

test('blocked sources and departments with no hiring source remain explicit gaps', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  const result = await discoverSchoolSources(schoolAt('https://example.edu/faculty-jobs', ['CS', 'ECE']), []);
  assert.equal(result.documents.length, 1); assert.equal(result.documents[0].readable, false);
  assert.ok(result.issues.some(s => /HTTP 403/.test(s)));
  assert.ok(result.departments.find(d => d.department === 'ECE').issues.some(s => /No saved hiring source/.test(s)));
  assert.ok(result.departments.find(d => d.department === 'CS').issues.some(s => /Could not read/.test(s)));
});

test('a page cap reports every remaining relevant posting rather than claiming complete coverage', async t => {
  const hub = 'https://example.edu/faculty-jobs';
  const links = Array.from({ length: 14 }, (_, i) => `<a href="/postings/${i + 1}">Assistant Professor ${i + 1}</a>`).join('');
  const pages = new Map([[hub, page('Faculty openings', links)], ...Array.from({ length: 14 }, (_, i) => [`https://example.edu/postings/${i + 1}`, page('Assistant Professor')])]);
  const calls = mockPages(t, pages);
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.equal(calls.length, 12); assert.equal(result.documents.length, 12);
  const unread = [...pages.keys()].filter(url => !calls.includes(url));
  assert.equal(unread.length, 3);
  for (const url of unread) assert.ok(result.issues.some(s => s.includes(url) && /page limit/.test(s)));
  assert.deepEqual(result.departments[0].issues, result.issues);
});

test('pagination beyond the depth budget is an explicit unread source', async t => {
  const hub = 'https://example.edu/jobs?page=1';
  const pages = new Map(Array.from({ length: 3 }, (_, i) => [`https://example.edu/jobs?page=${i + 1}`, page('Faculty openings', `<nav><a href="?page=${i + 2}">Next</a></nav>`)]));
  const calls = mockPages(t, pages);
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.equal(calls.length, 3);
  assert.ok(result.issues.some(s => /depth limit/.test(s) && s.includes('page=4')));
});

test('ambiguous linked destinations are attempted and unsupported hosts become coverage gaps', async t => {
  const hub = 'https://example.edu/faculty-jobs';
  const calls = mockPages(t, new Map([[hub, page('Faculty openings', '<p>Faculty applications are accepted through our portal.</p><a href="https://unsupported.example.com/advertisement">View Details</a>')]]));
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.deepEqual(calls, [hub], 'unsupported source must not make an external request');
  assert.equal(result.documents.length, 2);
  assert.ok(result.issues.some(s => s.includes('https://unsupported.example.com/advertisement') && /Could not read/.test(s)));
});

test('faculty titles and full advertisements do not need a numeric portal or careers path', async t => {
  const hub = 'https://example.edu/hiring';
  const calls = mockPages(t, new Map([
    [hub, page('Faculty recruitment', '<a href="/fall-announcement">Assistant Professor in Computer Science</a><a href="/advert">Full advertisement</a>')],
    ['https://example.edu/fall-announcement', page('Assistant Professor', '<a href="/submission-checklist">Application instructions</a>')],
    ['https://example.edu/advert', page('Faculty position announcement')],
    ['https://example.edu/submission-checklist', page('Application instructions', '<p>A research statement and teaching statement are required.</p>')],
  ]));
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.equal(calls.length, 4); assert.deepEqual(result.issues, []);
  assert.ok(result.documents.some(d => d.url.endsWith('/submission-checklist') && /teaching statement/.test(d.text)));
});

test('faculty navigation and award news do not consume the hiring crawl budget', async t => {
  const hub = 'https://example.edu/hiring';
  const noise = [
    ['/cds-faculty/stay-connected/giving/', 'Giving'], ['/cds-faculty/stay-connected/news/', 'News'],
    ['/cds-faculty/explore/about/', 'Learn more'], ['/people/faculty/', 'Faculty'],
    ['/news/assistant-professor-wins-career-award', 'Assistant Professor wins CAREER award'],
    ['/faculty-office/faculty-development/orientation.html', 'Faculty orientation'],
    ...Array.from({ length: 20 }, (_, i) => [`/cds-faculty/profile/person-${i}`, `Professor Person ${i}`]),
  ];
  const links = noise.map(([url, label]) => `<a href="${url}">${label}</a>`).join('') +
    '<a href="/cs/faculty-hiring">Faculty hiring</a><a href="/news/faculty-search">Applications open: Assistant Professor in CS</a>';
  const calls = mockPages(t, new Map([[hub, page('Faculty recruitment', links)],
    ['https://example.edu/cs/faculty-hiring', page('Faculty hiring')],
    ['https://example.edu/news/faculty-search', page('Assistant Professor in Computer Science')],
  ]));
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.equal(calls.length, 3); assert.deepEqual(result.issues, []);
  assert.ok(calls.includes('https://example.edu/news/faculty-search'));
});

test('Caltech-style application forms are skipped while public advertisements are read', async t => {
  const hub = 'https://example.edu/hiring', ad = 'https://example.edu/jobs/358';
  const calls = mockPages(t, new Map([[hub, page('Faculty positions', '<a href="/jobs/358">Assistant Professor in CS</a>')],
    [ad, page('Assistant Professor', '<a href="/jobs/358/applies/new">Apply now</a><a href="/jobs/358/applies/start">Start application</a>')],
  ]));
  const result = await discoverSchoolSources(schoolAt(hub), [{ id: 'saved', schoolId: 'example', department: 'CS', workflow: 'Considering', sourceUrl: ad, applicationUrl: ad + '/applies/new' }]);
  assert.deepEqual(new Set(calls), new Set([hub, ad]));
  assert.deepEqual(result.issues, []);
});

test('source text and link truncation both prevent full-coverage claims', async t => {
  const hub = 'https://example.edu/faculty-jobs';
  const manyLinks = Array.from({ length: 201 }, (_, i) => `<a href="/about/${i}">About ${i}</a>`).join('');
  mockPages(t, new Map([[hub, page('Faculty openings', '<p>' + 'Faculty research. '.repeat(4500) + '</p>' + manyLinks)]]));
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.equal(result.documents[0].links.length, 200); assert.equal(result.documents[0].linkLimitReached, true);
  assert.ok(result.issues.some(s => /text was truncated/.test(s)));
  assert.ok(result.issues.some(s => /link limit/.test(s)));
});

test('the soft time budget stops new reads and retains every queued gap', async t => {
  const hub = 'https://example.edu/faculty-jobs';
  const savedNow = Date.now, savedFetch = globalThis.fetch; let now = 0, calls = 0;
  Date.now = () => now;
  globalThis.fetch = async () => { calls++; now += 46_000; return new Response(page('Faculty openings', '<a href="/postings/1">Assistant Professor</a>'), { headers: { 'content-type': 'text/html' } }); };
  t.after(() => { Date.now = savedNow; globalThis.fetch = savedFetch; });
  const result = await discoverSchoolSources(schoolAt(hub), []);
  assert.equal(calls, 1);
  assert.ok(result.issues.some(s => /time limit/.test(s) && s.includes('/postings/1')));
});

test('reads existing active-school postings, skips archived/other-school records, and limits concurrent requests', async t => {
  const hub = 'https://example.edu/faculty-jobs';
  const pages = new Map([[hub, page('Faculty openings')], ...[1, 2, 3, 4].map(i => [`https://example.edu/postings/${i}`, page('Assistant Professor')])]);
  const calls = mockPages(t, pages), baseFetch = globalThis.fetch;
  let active = 0, peak = 0;
  globalThis.fetch = async (...args) => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    try { return await baseFetch(...args); } finally { active--; }
  };
  const openings = [1, 2, 3, 4, 5, 6].map(i => ({ id: String(i), schoolId: i === 6 ? 'other' : 'example', department: 'CS', sourceUrl: `https://example.edu/postings/${i}`, applicationUrl: '', workflow: i === 5 ? 'Archived' : 'Considering' }));
  const result = await discoverSchoolSources(schoolAt(hub), openings);
  assert.equal(calls.length, 5); assert.equal(peak, 3); assert.deepEqual(result.issues, []);
  assert.equal(calls.some(s => /\/(5|6)$/.test(s)), false);
  assert.equal(new Set(result.documents.map(d => d.requestId)).size, 5, 'receipts have stable, unique request identities');
});
