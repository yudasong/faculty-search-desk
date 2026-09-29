import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school, sourceUrl, finding, applicationUrl } from './helpers/research-harness.mjs';
import { page } from './fixtures/discovery.mjs';
const key = 'fixture-browser-key';
const posting = 'https://example.edu/postings/2027';
const review = (url, outcome = 'no_openings', openingUrls = []) => ({ url, outcome, openingUrls, departments: ['CS'], reason: 'Full official source was read for this department.' });
function setup(t) {
  const h = harness(t);
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }] });
  h.sourceRespond(url => new Response(page('Computer Science hiring', url === posting ? '<p>Application deadline: November 30, 2026. Submit CV, research and teaching statements.</p>' : '<p>Check current advertised positions for the application details.</p>'), { headers: { 'content-type': 'text/html' } }));
  return h;
}

test('a model checked-school claim without source assessments stays partial', async t => {
  const h = setup(t);
  await h.api.startSchoolResearch(school.id, 'school-test', key);
  h.respond(() => complete([], { checkedSchoolIds: [school.id], inspectedUrls: [sourceUrl] }, []));
  await h.api.pollResearch('school-test', key);
  const job = h.get('meta', 'school-test');
  assert.equal(job.needsRetry, true); assert.match(job.summary, /0\/1 schools verified/);
  assert.ok(job.coverageIssues.some(s => s.includes('analysis is missing')));
});

test('search-discovered candidates are directly read before a single claimed extraction pass', async t => {
  const h = setup(t); const sourcesRead = [];
  h.sourceRespond(url => { sourcesRead.push(url); return new Response(page('Faculty search in Computer Science', '<p>Application deadline: November 30, 2026. Submit CV, research and teaching statements.</p>'), { headers: { 'content-type': 'text/html' } }); });
  await h.api.startSchoolResearch(school.id, 'school-test', key);
  const reviews = [review(sourceUrl, 'openings', [posting]), review(posting, 'openings', [posting])];
  h.respond(call => call.method === 'POST' ? Response.json({ id: 'resp_verify', status: 'queued' }) : complete([{ ...finding, sourceUrl: posting, applicationUrl: null }], { sourceReviews: reviews, inspectedUrls: [sourceUrl, posting] }, [posting]));
  await Promise.all([h.api.pollResearch('school-test', key), h.api.pollResearch('school-test', key)]);
  assert.equal(h.count('opening'), 0, 'discovery response alone never imports');
  assert.equal(sourcesRead.filter(u => u === posting).length, 1);
  const posts = h.calls.filter(c => c.method === 'POST');
  assert.equal(posts.length, 2, 'competing polls must not duplicate paid verification');
  const input = JSON.parse(posts[1].body.input);
  assert.match(input.sourceDocuments.find(d => d.url === posting).text, /November 30, 2026/);
  assert.equal(posts[1].body.tools, undefined, 'final extraction only uses directly read documents');
  h.respond(() => complete([{ ...finding, sourceUrl: posting, applicationUrl: null, deadline: '2026-11-30', deadlineType: 'Application deadline', hardDeadline: '2026-11-30', materials: 'CV; research and teaching statements' }], { sourceReviews: reviews, inspectedUrls: [sourceUrl, posting] }, []));
  await h.api.pollResearch('school-test', key);
  assert.equal(h.count('opening'), 1); assert.equal(h.records('opening')[0].deadline, '2026-11-30');
  assert.equal(h.get('meta', 'school-test').needsRetry, false);
  assert.equal(h.get('meta', 'school-test').documents, undefined, 'discard transient source text after import');
});

test('a search snippet cannot authorize an import when the posting is blocked', async t => {
  const h = setup(t);
  h.sourceRespond(url => url === posting ? new Response('Denied', { status: 403 }) : new Response(page('Computer Science hiring'), { headers: { 'content-type': 'text/html' } }));
  await h.api.startSchoolResearch(school.id, 'school-test', key);
  const output = () => complete([{ ...finding, sourceUrl: posting, applicationUrl: null }], { sourceReviews: [review(sourceUrl, 'openings', [posting]), review(posting, 'openings', [posting])], inspectedUrls: [sourceUrl, posting] }, [posting]);
  h.respond(call => call.method === 'POST' ? Response.json({ id: 'resp_verify', status: 'queued' }) : output());
  await h.api.pollResearch('school-test', key); await h.api.pollResearch('school-test', key);
  assert.equal(h.count('opening'), 0); assert.equal(h.get('meta', 'school-test').needsRetry, true);
  assert.match(h.get('meta', 'school-test').coverageIssues.join('\n'), /full source could not be read/);
});

test('a different institution at a shared portal is rejected during school discovery', async t => {
  const h = setup(t);
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: applicationUrl }] });
  h.sourceRespond(() => Response.json({ position_id: 12345, landing_page_url: applicationUrl, position_name: 'Faculty search', institution: 'Another University', active_status: 'Open', landing_page_description: 'Tenure-track faculty in computer science. This current posting invites applicants with a strong research and teaching record.', application_instructions: 'Submit a CV and research and teaching statements.' }));
  await h.api.startSchoolResearch(school.id, 'school-test', key);
  h.respond(() => complete([{ ...finding, sourceUrl: applicationUrl }], { inspectedUrls: [applicationUrl], sourceReviews: [review(applicationUrl, 'openings', [applicationUrl])] }, []));
  await h.api.pollResearch('school-test', key);
  assert.equal(h.count('opening'), 0);
  assert.match(h.get('meta', 'school-test').coverageIssues.join('\n'), /does not match the institution/);
});

test('an imported posting accounts for a saved alias without duplicating or changing workflow', async t => {
  const h = setup(t), alias = 'https://example.edu/postings/2026', apply = posting + '/pre_apply';
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: alias }] });
  h.put('opening', 'saved', { ...finding, id: 'saved', sourceUrl: alias, applicationUrl: apply, workflow: 'Preparing', notes: 'Keep this note' });
  h.sourceRespond(() => new Response(page('Faculty search', `<p>Current computer science faculty advertisement.</p><a href="${apply}">Apply for this Job</a>`), { headers: { 'content-type': 'text/html' } }));
  await h.api.startSchoolResearch(school.id, 'school-test', key);
  const reviews = [review(alias, 'openings', [posting]), review(posting, 'openings', [posting])];
  h.respond(call => call.method === 'POST' ? Response.json({ id: 'resp_verify', status: 'queued' }) : complete([{ ...finding, sourceUrl: posting, applicationUrl: apply }], { sourceReviews: reviews, inspectedUrls: [alias, posting] }, []));
  await h.api.pollResearch('school-test', key); await h.api.pollResearch('school-test', key);
  assert.equal(h.count('opening'), 1);
  assert.equal(h.get('opening', 'saved').workflow, 'Preparing'); assert.equal(h.get('opening', 'saved').notes, 'Keep this note');
  const job = h.get('meta', 'school-test');
  assert.equal(job.needsRetry, false); assert.ok(job.importedUrls.includes(alias));
  assert.equal(job.sourceReviews.length, 2, 'retain decisions for later coverage auditing');
});

test('a saved interdisciplinary lead does not become a required department', async t => {
  const h = setup(t);
  h.put('opening', 'outside', { ...finding, id: 'outside', department: 'Architecture', sourceUrl: posting, applicationUrl: '', workflow: 'Inbox' });
  await h.api.startSchoolResearch(school.id, 'school-test', key);
  const input = JSON.parse(h.calls[0].body.input);
  assert.ok(input.sourceDocuments.some(s => s.url === posting), 'existing lead is still read');
  h.respond(() => complete([], { inspectedUrls: [sourceUrl, posting], sourceReviews: [review(sourceUrl), { ...review(posting, 'irrelevant'), departments: [], reason: 'Architecture opening outside the specified CS-related role preferences.' }] }, []));
  await h.api.pollResearch('school-test', key);
  assert.equal(h.get('meta', 'school-test').needsRetry, false);
  assert.equal(h.get('opening', 'outside').workflow, 'Inbox', 'a relevance assessment never deletes or archives a saved choice');
});

test('saved alias coverage is repaired locally without spending or dropping unrelated gaps', async t => {
  const h = setup(t), alias = 'https://example.edu/postings/2028', apply = posting + '/pre_apply';
  const aliasGap = `${alias}: discovered posting has not been imported or explicitly ruled out.`;
  h.put('opening', 'saved', { ...finding, id: 'saved', sourceUrl: posting, applicationUrl: apply, workflow: 'Preparing' });
  h.put('run', 'old-run', { id: 'old-run', summary: '0/1 schools verified', failures: [aliasGap, 'CS page 2 blocked.'] });
  h.put('meta', 'school-test', { id: 'old-run', recordKey: 'school-test', scope: 'school', status: 'completed', needsRetry: true, schoolIds: [school.id], requestIds: [], summary: '0/1 schools verified', importedUrls: [posting], coverageIssues: [aliasGap, 'CS page 2 blocked.'], sources: [{ url: alias, method: 'html', readable: true, complete: true, links: [{ label: 'Apply for this Job', url: apply }] }] });
  await Promise.all([h.api.reconcileSchoolAliases('school-test'), h.api.reconcileSchoolAliases('school-test')]);
  const job = h.get('meta', 'school-test');
  assert.deepEqual(job.coverageIssues, ['CS page 2 blocked.']); assert.equal(job.needsRetry, true);
  assert.deepEqual(h.get('run', 'old-run').failures, ['CS page 2 blocked.']);
  assert.equal(h.calls.length, 0); assert.equal(h.get('opening', 'saved').workflow, 'Preparing');
});
