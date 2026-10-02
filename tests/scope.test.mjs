import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school, sourceUrl, finding } from './helpers/research-harness.mjs';
import { page } from './fixtures/discovery.mjs';
const key = 'fixture-browser-key';
const posting = 'https://example.edu/postings/1234';
const review = (url, outcome, openingUrls) => ({ url, outcome, openingUrls, departments: ['CS'], reason: 'The complete source was assessed against the requested subject focus.' });
function setup(t, title, text) {
  const h = harness(t);
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }] });
  h.sourceRespond(url => new Response(url === posting ? page(title, `<p>${text}</p>`) : page('Computer Science hiring', `<a href="${posting}">${title}</a>`), { headers: { 'content-type': 'text/html' } }));
  return h;
}
function result(h, title, scopeEvidence) {
  h.respond(() => complete([{ ...finding, title, sourceUrl: posting, applicationUrl: null, scopeEvidence }], { inspectedUrls: [sourceUrl, posting], sourceReviews: [review(sourceUrl, 'openings', [posting]), review(posting, 'openings', [posting])] }, []));
}

test('statistics roles import with subject evidence from their posting', async t => {
  const title = 'Professor of Statistics', quote = 'Research in statistical inference and machine learning';
  const h = setup(t, title, quote);
  await h.api.startSchoolResearch(school.id, 'scope-test', key);
  assert.match(h.calls[0].body.instructions, /statistics, AI\/ML and data-science hiring pages/);
  result(h, title, { area: 'Statistics', quote, reason: 'The role recruits researchers in statistical methods and learning.' });
  await h.api.pollResearch('scope-test', key);
  assert.equal(h.count('opening'), 1); assert.equal(h.get('meta', 'scope-test').needsRetry, false);
  assert.equal(h.records('opening')[0].scopeEvidence, undefined, 'internal assessment is not added to editable application data');
});

test('an ECE label cannot authorize a generic power-systems role without subject evidence', async t => {
  const title = 'Professor of Power Engineering';
  const h = setup(t, title, 'Research on power-grid hardware using computational tools.');
  await h.api.startSchoolResearch(school.id, 'scope-test', key);
  result(h, title, null);
  await h.api.pollResearch('scope-test', key);
  assert.equal(h.count('opening'), 0); assert.equal(h.get('meta', 'scope-test').needsRetry, true);
  assert.match(h.get('meta', 'scope-test').coverageIssues.join(' '), /central research-area fit was not established/);
});

test('a CS quote from the hub cannot establish subject fit for a different posting', async t => {
  const title = 'Professor of Architecture';
  const h = setup(t, title, 'Teaching design studios and using data-analysis tools.');
  await h.api.startSchoolResearch(school.id, 'scope-test', key);
  result(h, title, { area: 'CS', quote: 'Computer Science hiring', reason: 'Supposed computing role.' });
  await h.api.pollResearch('scope-test', key);
  assert.equal(h.count('opening'), 0);
  assert.match(h.get('meta', 'scope-test').coverageIssues.join(' '), /evidence does not match this posting/);
});

test('deliberate subject exclusions complete coverage without adding irrelevant jobs', async t => {
  const h = setup(t, 'Professor of Environmental Science', 'Research on water resources and field sampling.');
  await h.api.startSchoolResearch(school.id, 'scope-test', key);
  h.respond(() => complete([], { inspectedUrls: [sourceUrl, posting], sourceReviews: [review(sourceUrl, 'no_openings', []), { ...review(posting, 'irrelevant', []), reason: 'Environmental field research outside CS, AI, ML, statistics and data science.' }] }, []));
  await h.api.pollResearch('scope-test', key);
  assert.equal(h.count('opening'), 0); assert.equal(h.get('meta', 'scope-test').needsRetry, false);
});

test('an explicitly pasted posting still receives full analysis outside discovery subjects', async t => {
  const h = setup(t, 'Professor of Architecture', 'Design studios and urban planning.');
  h.put('request', 'manual', { id: 'manual', url: posting, status: 'Queued' });
  await h.api.startResearch('link', 'manual', false, key);
  h.respond(() => complete([{ ...finding, sourceRequestId: 'manual', sourceUrl: posting, title: 'Professor of Architecture', applicationUrl: null, scopeEvidence: null }], { inspectedUrls: [posting], completedRequestIds: ['manual'] }, []));
  await h.api.pollResearch('research-link-manual', key);
  assert.equal(h.count('opening'), 1); assert.equal(h.get('request', 'manual').status, 'Researched');
});

for (const title of ['Professor of Biostatistics', 'Professor of AI in Psychology', 'Professor of Data Science, Business School', 'Professor of Statistics, Wharton School', 'Professor of Machine Learning for Physics']) {
  test(`discovery excludes ${title} even with a valid AI/statistics quote`, async t => {
    const quote = 'Research in statistical inference and machine learning';
    const h = setup(t, title, quote);
    h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }, { department: 'CS', url: posting }] });
    await h.api.startSchoolResearch(school.id, 'scope-test', key);
    result(h, title, { area: 'ML', quote, reason: 'Method is mentioned.' });
    await h.api.pollResearch('scope-test', key);
    assert.equal(h.count('opening'), 0);
    assert.equal(h.get('meta', 'scope-test').needsRetry, false, 'deliberate exclusion is accounted for');
    assert.match(h.get('meta', 'scope-test').summary, /1 out-of-scope/);
  });
}

test('incidental collaboration with biostatistics or psychology does not exclude a real CS hire', async t => {
  const quote = 'Research in machine learning';
  const h = setup(t, 'Professor of Computer Science', quote + '. Faculty collaborate with psychology and biostatistics departments.');
  await h.api.startSchoolResearch(school.id, 'scope-test', key);
  result(h, 'Professor of Computer Science', { area: 'ML', quote, reason: 'Core ML research.' });
  await h.api.pollResearch('scope-test', key);
  assert.equal(h.count('opening'), 1);
});

test('an excluded department cannot hide behind a generic model title', t => {
  const h = harness(t);
  assert.ok(h.scope.discoveryExclusionReason({ title: 'Assistant Professor', department: 'Statistics' }, { text: 'The School of Business invites applications for an assistant professor in machine learning.' }));
  assert.equal(h.scope.discoveryExclusionReason({ title: 'Professor of Statistics', department: 'Statistics' }, { text: 'Our faculty collaborate with the School of Business on research.' }), null);
});

test('CS data management and CS education are not confused with excluded hiring units', t => {
  const h = harness(t);
  for (const title of ['Assistant Professor of Computer Science — Data Management', 'Professor of Computer Science Education'])
    assert.equal(h.scope.discoveryExclusionReason({ title, department: 'CS' }), null);
  assert.ok(h.scope.discoveryExclusionReason({ title: 'Assistant Professor', department: 'Management' }));
});
