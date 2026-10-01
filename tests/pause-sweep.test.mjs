import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school } from './helpers/research-harness.mjs';

const browserKey = 'sk-proj-pause-fixture-not-a-real-key';
const posts = h => h.calls.filter(call => call.method === 'POST');
const childJobs = h => h.records('meta').filter(record => record.scope === 'school');

function configure(h) {
  h.env.FACULTY_DESK_LOCAL_ONLY = '1';
  h.put('school', school.id, { ...school, considering: false });
  const ids = ['alpha', 'beta', 'gamma', 'delta'];
  for (const id of ids) h.put('school', id, { ...school, id, name: id, considering: true,
    domain: `${id}.edu`, sources: [{ department: 'CS', url: `https://${id}.edu/cs/jobs` }] });
  return ids;
}

function provider(h) {
  const started = new Map(), finished = new Set();
  let beforeGet;
  h.respond(async call => {
    if (call.method === 'POST') {
      const id = `resp_pause_${started.size + 1}`;
      started.set(id, JSON.parse(call.body.input));
      return Response.json({ id, status: 'queued' });
    }
    const id = call.url.split('/').at(-1);
    await beforeGet?.(id);
    if (!finished.has(id)) return Response.json({ id, status: 'in_progress' });
    const input = started.get(id), target = input.schoolsToSearch[0];
    const sourceReviews = input.sourceDocuments.map(source => ({ url: source.url, outcome: 'no_openings',
      openingUrls: [], reason: 'The hiring page has no matching faculty opening.', departments: target.departments }));
    return complete([], { checkedSchoolIds: [target.id], inspectedUrls: input.sourceDocuments.map(source => source.url), sourceReviews }, []);
  });
  return { started, finished, beforeGet: callback => { beforeGet = callback; },
    responseFor: schoolId => [...started].find(([, input]) => input.schoolsToSearch[0].id === schoolId)?.[0] };
}

test('a user pause persists without a key and ordinary polls, starts, and retries cannot resume it', async t => {
  const h = harness(t), ids = configure(h); provider(h);
  await h.sweep.startSweep('considering', ids, browserKey);
  const previous = h.get('meta', 'research-sweep'), originalJobs = childJobs(h), callsBefore = h.calls.length;
  const paused = await h.sweep.pauseSweep();
  assert.equal(paused.job.status, 'paused');
  assert.equal(paused.configured, false, 'pausing local state does not require access to the browser key');
  assert.ok(h.get('meta', 'research-sweep').pausedAt);
  assert.equal(h.get('meta', 'research-sweep').id, previous.id);
  assert.deepEqual(h.get('meta', 'research-sweep').tasks, previous.tasks);
  assert.deepEqual(childJobs(h), originalJobs, 'pausing preserves provider response IDs and child state');
  for (const key of [undefined, browserKey, browserKey]) assert.equal((await h.sweep.pollSweep(key)).job.status, 'paused');
  assert.equal((await h.sweep.sweepStatus(browserKey)).job.status, 'paused', 'a fresh state read restores the pause');
  assert.equal((await h.sweep.startSweep('all', undefined, browserKey)).job.status, 'paused');
  assert.equal((await h.sweep.retrySchools(undefined, browserKey)).job.status, 'paused');
  assert.equal(h.calls.length, callsBefore, 'a paused school queue makes no provider calls');
  assert.deepEqual(h.get('meta', 'research-sweep').tasks, previous.tasks);
});

test('resuming requires the browser key and continues saved responses without repeating completed schools or attempts', async t => {
  const h = harness(t), ids = configure(h), service = provider(h);
  await h.sweep.startSweep('considering', ids, browserKey);
  service.finished.add(service.responseFor('alpha'));
  await h.sweep.pollSweep(browserKey);
  assert.equal(posts(h).length, 3);
  const parent = h.get('meta', 'research-sweep'), originalJobs = childJobs(h);
  assert.equal(originalJobs.find(job => job.schoolIds.includes('alpha')).status, 'completed');
  await h.sweep.pauseSweep();
  assert.equal((await h.sweep.retrySchools('alpha', browserKey)).job.status, 'paused');
  assert.deepEqual(h.get('meta', 'research-sweep').tasks, parent.tasks, 'retrying a completed school while paused cannot create a new attempt');
  await assert.rejects(h.sweep.resumeSweep(), /key/i);
  assert.equal((await h.sweep.sweepStatus(browserKey)).job.status, 'paused');
  assert.equal(posts(h).length, 3);
  service.finished.add(service.responseFor('beta'));
  service.finished.add(service.responseFor(parent.tasks[2].schoolId));
  const resumed = await h.sweep.resumeSweep(browserKey);
  assert.equal(resumed.job.status, 'running');
  assert.ok(!h.get('meta', 'research-sweep').pausedAt);
  assert.equal(h.get('meta', 'research-sweep').id, parent.id);
  assert.deepEqual(h.get('meta', 'research-sweep').tasks, parent.tasks);
  assert.equal(posts(h).length, 4, 'only the previously pending fourth school starts');
  assert.deepEqual(resumed.job.schools.map(item => item.status), ['completed', 'completed', 'completed', 'running']);
  for (const old of originalJobs) assert.equal(childJobs(h).find(job => job.id === old.id)?.responseId, old.responseId);
  for (const id of ids) assert.equal([...service.started.values()].filter(input => input.schoolsToSearch[0].id === id).length, 1);
});

test('pausing while a provider poll holds the dispatch lease prevents the next schools from starting', async t => {
  const h = harness(t), ids = configure(h), service = provider(h);
  await h.sweep.startSweep('considering', ids, browserKey);
  const first = service.responseFor('alpha'); service.finished.add(first);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  service.beforeGet(async id => { if (id === first) { entered(); await gate; } });
  const polling = h.sweep.pollSweep(browserKey);
  await ready;
  try {
    const paused = await h.sweep.pauseSweep();
    assert.equal(paused.job.status, 'paused', 'the held dispatch lease must not prevent a pause');
    assert.ok(h.get('meta', 'research-sweep').pausedAt);
  } finally { release(); }
  const result = await polling;
  assert.equal(result.job.status, 'paused');
  assert.equal(posts(h).length, 2, 'the completed in-flight result does not release a slot into new spending while paused');
  assert.deepEqual(result.job.schools.map(item => item.status), ['completed', 'running', 'pending', 'pending']);
  const callsBefore = h.calls.length;
  await h.sweep.pollSweep(browserKey);
  assert.equal(h.calls.length, callsBefore);
});
