import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school, finding } from './helpers/research-harness.mjs';
import { harvardHub, harvardPosting, harvardSchool, harvardPages, page } from './fixtures/discovery.mjs';

const browserKey = 'sk-proj-sweep-fixture-not-a-real-key';
const wrongKey = 'sk-proj-other-project-fixture-not-a-real-key';
const posts = h => h.calls.filter(call => call.method === 'POST');
const childJobs = h => h.records('meta').filter(record => record.scope === 'school');
const activeJobs = h => childJobs(h).filter(job => ['starting', 'running', 'blocked'].includes(job.status));
const normalized = value => { const url = new URL(value); url.searchParams.sort(); return url.toString(); };

function configure(h, count = 4) {
  h.env.FACULTY_DESK_LOCAL_ONLY = '1';
  h.put('school', school.id, { ...school, considering: false });
  return Array.from({ length: count }, (_, index) => {
    const id = ['alpha', 'beta', 'gamma', 'delta'][index];
    const item = { ...school, id, name: id, domain: id + '.edu', sources: [{ department: 'CS', url: `https://${id}.edu/cs/jobs` }], considering: true };
    h.put('school', id, item); return item;
  });
}

function provider(h) {
  const started = new Map(), outcomes = new Map();
  h.respond(call => {
    if (call.method === 'POST') {
      const input = JSON.parse(call.body.input);
      const id = `resp_sweep_${started.size + 1}`;
      started.set(id, input); return Response.json({ id, status: 'queued' });
    }
    const id = call.url.split('/').at(-1), outcome = outcomes.get(id);
    if (call.authorization === 'Bearer ' + wrongKey) return new Response('', { status: 404 });
    if (!outcome) return Response.json({ id, status: 'in_progress' });
    if (outcome === 'failed') return Response.json({ id, status: 'failed' });
    const input = started.get(id), target = input.schoolsToSearch[0];
    const sourceReviews = input.sourceDocuments.map(source => ({ url: source.url, outcome: 'no_openings', openingUrls: [], reason: 'The supplied hiring page states no matching faculty opening.', departments: target.departments }));
    const result = typeof outcome === 'function' ? outcome(input, sourceReviews) : { sourceReviews };
    return complete([], { checkedSchoolIds: [target.id], inspectedUrls: input.sourceDocuments.map(d => d.url), ...result }, []);
  });
  return { started, outcomes, responseFor: schoolId => [...started].find(([, input]) => input.schoolsToSearch[0].id === schoolId)?.[0] };
}

test('concurrent polls share one two-school capacity reservation while discovery is delayed', async t => {
  const h = harness(t), schools = configure(h), service = provider(h);
  let entered = 0, release, bothStarted;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { bothStarted = resolve; });
  h.sourceRespond(async () => {
    entered++; if (entered === 2) bothStarted(); await gate;
    return new Response(page('Faculty hiring'), { headers: { 'content-type': 'text/html' } });
  });
  const starting = h.sweep.startSweep('considering', schools.map(s => s.id), browserKey);
  await ready;
  try {
    await Promise.all(Array.from({ length: 5 }, () => h.sweep.pollSweep(browserKey)));
    assert.equal(entered, 2); assert.equal(activeJobs(h).length, 2); assert.equal(posts(h).length, 0);
  } finally { release(); }
  await starting;
  await Promise.all(Array.from({ length: 5 }, () => h.sweep.pollSweep(browserKey)));
  assert.equal(posts(h).length, 2); assert.equal(activeJobs(h).length, 2);
  const first = service.responseFor('alpha'); service.outcomes.set(first, 'complete');
  await Promise.all(Array.from({ length: 5 }, () => h.sweep.pollSweep(browserKey)));
  assert.equal(posts(h).length, 3, 'one completed child releases exactly one slot');
  assert.equal(activeJobs(h).length, 2);
  assert.equal(childJobs(h).filter(job => job.status === 'completed').length, 1);
});

test('partial and failed schools retry only explicitly and once; completed schools and imported totals survive', async t => {
  const h = harness(t), schools = configure(h, 3), service = provider(h);
  await h.sweep.startSweep('considering', schools.map(s => s.id), browserKey);
  service.outcomes.set(service.responseFor('alpha'), 'complete');
  const betaSource = schools[1].sources[0].url;
  const betaFinding = { ...finding, schoolId: 'beta', sourceUrl: betaSource, applicationUrl: null, title: 'Beta CS faculty' };
  service.outcomes.set(service.responseFor('beta'), () => ({ openings: [betaFinding], sourceReviews: [] }));
  await h.sweep.pollSweep(browserKey);
  service.outcomes.set(service.responseFor('gamma'), 'failed');
  let state = await h.sweep.pollSweep(browserKey);
  assert.deepEqual(state.job.schools.map(s => s.status), ['completed', 'partial', 'failed']);
  assert.equal(state.job.completedSchools, 1); assert.equal(state.job.added, 1); assert.equal(state.job.needsRetry, true);
  assert.equal(state.job.processedSchools, 3); assert.equal(state.job.partialSchools, 1); assert.equal(state.job.failedSchools, 1);
  assert.match(state.job.summary, /3\/3 schools processed; 1 with coverage gaps; 1 failed/);
  assert.match(state.job.summary, /Across all attempts/);
  for (let i = 0; i < 3; i++) await h.sweep.pollSweep(browserKey);
  assert.equal(posts(h).length, 3, 'ordinary polling cannot spend on failed/partial retries');
  await Promise.all([h.sweep.retrySchools(undefined, browserKey), h.sweep.retrySchools(undefined, browserKey)]);
  assert.equal(posts(h).length, 5, 'simultaneous retry requests consume one new attempt per eligible school');
  assert.equal([...service.started.values()].filter(input => input.schoolsToSearch[0].id === 'alpha').length, 1);
  assert.deepEqual(h.get('meta', 'research-sweep').tasks.map(task => task.attempt), [0, 1, 1]);
  for (const [id, input] of service.started) {
    if (input.schoolsToSearch[0].id === 'beta' && id !== service.responseFor('beta')) {
      service.outcomes.set(id, (_input, sourceReviews) => ({ openings: [betaFinding], sourceReviews: sourceReviews.map(review => ({ ...review, outcome: 'openings', openingUrls: [betaSource] })) }));
    } else if (input.schoolsToSearch[0].id === 'gamma' && id !== service.responseFor('gamma')) service.outcomes.set(id, 'complete');
  }
  state = await h.sweep.pollSweep(browserKey);
  assert.equal(state.job.completedSchools, 3); assert.equal(state.job.added, 1); assert.equal(state.job.updated, 1);
  assert.equal(h.count('opening'), 1, 'retry updates the staged opening rather than duplicating it');
  await h.sweep.retrySchools(undefined, browserKey); await h.sweep.pollSweep(browserKey);
  assert.equal(posts(h).length, 5, 'bulk retry skips every completed school');
  await h.sweep.retrySchools('alpha', browserKey);
  assert.equal(posts(h).length, 6, 'explicitly searching one completed school again starts one fresh attempt');
  assert.deepEqual(h.get('meta', 'research-sweep').tasks.map(task => task.attempt), [1, 1, 1]);
});

test('missing and wrong browser keys pause dispatch and preserve response IDs until the original key resumes', async t => {
  const h = harness(t), schools = configure(h, 3), service = provider(h);
  await h.sweep.startSweep('considering', schools.map(s => s.id), browserKey);
  const originals = childJobs(h).map(job => job.responseId), callsBefore = h.calls.length;
  const missing = await h.sweep.pollSweep();
  assert.equal(missing.configured, false); assert.equal(h.calls.length, callsBefore);
  assert.equal(posts(h).length, 2, 'missing key cannot fall back to an environment key or launch the third school');
  const blocked = await h.sweep.pollSweep(wrongKey);
  assert.equal(blocked.job.status, 'blocked'); assert.equal(posts(h).length, 2);
  assert.deepEqual(childJobs(h).map(job => job.responseId), originals);
  assert.ok(childJobs(h).every(job => job.status === 'blocked'));
  await h.sweep.pollSweep(browserKey);
  assert.ok(childJobs(h).every(job => job.status === 'running'));
  assert.deepEqual(childJobs(h).map(job => job.responseId), originals);
  for (const id of originals) service.outcomes.set(id, 'complete');
  await h.sweep.pollSweep(browserKey);
  assert.equal(posts(h).length, 3, 'only the still-pending school starts after recovery');
  assert.equal([...service.started.values()].filter(input => input.schoolsToSearch[0].id === 'alpha').length, 1);
  assert.equal([...service.started.values()].filter(input => input.schoolsToSearch[0].id === 'beta').length, 1);
});

test('legacy broad coverage is explicitly unverified and does not start research while being viewed', async t => {
  const h = harness(t);
  h.put('meta', 'research', { id: 'legacy', scope: 'all', status: 'completed', schoolIds: ['alpha', 'beta'], requestIds: [], startedAt: new Date().toISOString(), summary: '2/2 schools checked.', checked: 1, needsRetry: false });
  const result = await h.sweep.sweepStatus(browserKey);
  assert.equal(result.job.legacyCoverage, true); assert.equal(result.job.needsRetry, true);
  assert.equal(result.job.completedSchools, undefined); assert.equal(h.calls.length, 0);
  assert.equal(h.get('meta', 'research-sweep'), undefined);
});

test('a rejected API key persistently pauses pending dispatch until an explicit retry', async t => {
  const h = harness(t), schools = configure(h, 4);
  h.respond(() => new Response('', { status: 401 }));
  const started = await h.sweep.startSweep('considering', schools.map(s => s.id), browserKey);
  assert.equal(posts(h).length, 2); assert.equal(started.job.status, 'blocked');
  assert.equal(childJobs(h).length, 2);
  for (let i = 0; i < 3; i++) await h.sweep.pollSweep(browserKey);
  assert.equal(posts(h).length, 2, 'a rejected key must not be tried automatically against every remaining school');
  provider(h);
  await h.sweep.pollSweep(browserKey);
  assert.equal(posts(h).length, 2, 'fixing the provider does not silently retry a failed paid start');
  const retried = await h.sweep.retrySchools(undefined, browserKey);
  assert.equal(posts(h).length, 4); assert.equal(activeJobs(h).length, 2);
  assert.deepEqual(retried.job.schools.map(s => s.attempt), [1, 1, 0, 0]);
  assert.deepEqual(retried.job.schools.map(s => s.status), ['running', 'running', 'pending', 'pending']);
});

test('an expired child can be explicitly abandoned and retried without losing the previous attempt', async t => {
  const h = harness(t), schools = configure(h, 1); provider(h);
  await h.sweep.startSweep('considering', schools.map(s => s.id), browserKey);
  const old = childJobs(h)[0];
  h.respond(() => new Response('', { status: 404 }));
  const blocked = await h.sweep.pollSweep(browserKey);
  assert.equal(blocked.job.status, 'blocked'); assert.equal(childJobs(h)[0].status, 'blocked');
  const before = h.calls.length;
  const abandoned = await h.sweep.stopSchoolTracking('alpha', browserKey);
  assert.equal(h.calls.length, before, 'stop tracking neither spends nor claims to cancel provider work');
  assert.equal(abandoned.job.schools[0].status, 'failed'); assert.equal(posts(h).length, 1);
  h.respond(() => Response.json({ id: 'resp_recovered_after_expiry', status: 'queued' }));
  const retried = await h.sweep.retrySchools('alpha', browserKey);
  assert.equal(posts(h).length, 2); assert.equal(retried.job.schools[0].attempt, 1);
  const attempts = childJobs(h);
  assert.equal(attempts.length, 2);
  assert.equal(attempts.find(job => job.id === old.id).status, 'failed');
  assert.ok(attempts.some(job => job.id !== old.id && job.responseId === 'resp_recovered_after_expiry' && job.status === 'running'));
});

test('held-out Harvard posting is discovered, supplied in full to extraction, and imported without a known opening', async t => {
  const h = harness(t), calls = [];
  h.put('school', harvardSchool.id, harvardSchool);
  const pages = new Map([...harvardPages].map(([url, html]) => [normalized(url), html]));
  h.sourceRespond(url => {
    calls.push(url); assert.ok(pages.has(url), `Unexpected public-source GET: ${url}`);
    return new Response(pages.get(url), { headers: { 'content-type': 'text/html' } });
  });
  await h.api.startSchoolResearch('harvard', 'held-out-harvard', browserKey);
  const input = JSON.parse(posts(h)[0].body.input);
  assert.deepEqual(input.knownOpenings, []);
  assert.deepEqual(input.schoolsToSearch[0].sources, [{ department: 'CS', url: harvardHub }]);
  assert.ok(calls.includes(harvardPosting));
  const source = input.sourceDocuments.find(d => d.url === harvardPosting);
  assert.match(source.text, /December 1, 2026/); assert.match(source.text, /three reference letters/);
  const found = { ...finding, schoolId: 'harvard', title: 'Tenure-Track Professor in Computer Science', sourceUrl: harvardPosting,
    applicationUrl: harvardPosting + '/pre_apply', deadline: '2026-12-01', hardDeadline: '2026-12-01', deadlineType: 'Application deadline',
    deadlineText: 'Application deadline: December 1, 2026.', materials: 'Curriculum vitae; research statement; teaching statement; three reference letters.', letters: 'Three reference letters' };
  const sourceReviews = input.sourceDocuments.map(d => ({ url: d.url, departments: ['CS'],
    outcome: [normalized(harvardHub), harvardPosting].includes(d.url) ? 'openings' : d.url.includes('/search?') ? 'no_openings' : 'irrelevant',
    openingUrls: [normalized(harvardHub), harvardPosting].includes(d.url) ? [harvardPosting] : [],
    reason: [normalized(harvardHub), harvardPosting].includes(d.url) ? 'The supplied source identifies the CS tenure-track advertisement.' : 'Other displayed positions are outside the selected CS department.' }));
  h.respond(() => complete([found], { checkedSchoolIds: ['harvard'], inspectedUrls: input.sourceDocuments.map(d => d.url), sourceReviews }, []));
  await h.api.pollResearch('held-out-harvard', browserKey);
  assert.equal(posts(h).length, 1, 'a fully read discovered posting needs no duplicate verification request');
  assert.equal(h.count('opening'), 1);
  const saved = h.records('opening')[0], job = h.get('meta', 'held-out-harvard');
  assert.equal(saved.schoolId, 'harvard'); assert.equal(saved.sourceUrl, harvardPosting);
  assert.equal(saved.applicationUrl, harvardPosting + '/pre_apply'); assert.equal(saved.deadline, '2026-12-01');
  assert.match(saved.materials, /teaching statement/); assert.equal(saved.workflow, 'Inbox');
  assert.equal(job.status, 'completed'); assert.equal(job.needsRetry, false); assert.deepEqual(job.coverageIssues, []);
});
