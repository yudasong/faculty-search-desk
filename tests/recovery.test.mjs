import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school, sourceUrl, finding } from './helpers/research-harness.mjs';

const key = 'sk-proj-recovery-fixture-not-real';
const recordId = 'research-school-saved-example-0';
async function failedResult(h) {
  h.env.FACULTY_DESK_LOCAL_ONLY = '1';
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }] });
  h.put('meta', 'research-sweep', { id: 'saved', scope: 'considering', startedAt: new Date().toISOString(), tasks: [{ schoolId: school.id, name: school.name, attempt: 0 }] });
  await h.api.startSchoolResearch(school.id, recordId, key);
  h.respond(() => complete([], { summary: null }));
  await h.api.pollResearch(recordId, key);
  assert.equal(h.get('meta', recordId).status, 'failed');
}

test('saved-result recovery identifies invalid fields without starting a replacement analysis', async t => {
  const h = harness(t); await failedResult(h);
  const before = h.calls.length;
  const state = await h.sweep.recoverSchool(school.id, key);
  assert.equal(h.calls.length, before + 1);
  assert.equal(h.calls.at(-1).method, 'GET');
  assert.equal(state.job.schools[0].attempt, 0);
  assert.equal(state.job.schools[0].status, 'failed');
  assert.match(h.get('meta', recordId).error, /summary \(invalid_type\)/);
  assert.equal(h.count('opening'), 0);
});

test('saved-result recovery imports validated findings with the original response and attempt', async t => {
  const h = harness(t); await failedResult(h);
  const before = h.calls.length, responseId = h.get('meta', recordId).responseId;
  h.put('meta', recordId, { ...h.get('meta', recordId), dispatchBlocked: true, uncertainStart: true });
  h.respond(() => complete([finding], { sourceReviews: [{ url: sourceUrl, outcome: 'openings', openingUrls: [sourceUrl], departments: ['CS'], reason: 'CS faculty opening.' }] }));
  await h.sweep.recoverSchool(school.id, key);
  assert.equal(h.calls.length, before + 1); assert.equal(h.calls.at(-1).method, 'GET');
  assert.equal(h.get('meta', recordId).responseId, responseId);
  assert.equal(h.get('meta', recordId).status, 'completed');
  assert.equal(h.get('meta', recordId).dispatchBlocked, false);
  assert.equal(h.get('meta', recordId).uncertainStart, false);
  assert.equal(h.count('opening'), 1);
  await h.sweep.recoverSchool(school.id, key);
  assert.equal(h.calls.length, before + 1, 'completed results cannot be imported twice');
});

test('recovery cannot launch a paid verification pass for a newly discovered source', async t => {
  const h = harness(t); await failedResult(h);
  const before = h.calls.length;
  const unknown = 'https://example.edu/postings/999';
  h.sourceRespond(() => new Response('Forbidden', { status: 403 }));
  h.respond(() => complete([{ ...finding, sourceUrl: unknown }], { sourceReviews: [{ url: sourceUrl, outcome: 'openings', openingUrls: [unknown], departments: ['CS'], reason: 'Linked job.' }] }, [sourceUrl, unknown]));
  await h.sweep.recoverSchool(school.id, key);
  assert.equal(h.calls.length, before + 1); assert.equal(h.calls.at(-1).method, 'GET');
  assert.equal(h.count('opening'), 0);
  assert.equal(h.get('meta', recordId).needsRetry, true);
});

test('recovery authentication failures cannot enroll the saved result in automatic paid verification', async t => {
  const h = harness(t); await failedResult(h);
  const before = h.calls.length;
  h.respond(() => Response.json({ error: { message: 'Wrong project' } }, { status: 403 }));
  await h.sweep.recoverSchool(school.id, key);
  assert.equal(h.get('meta', recordId).status, 'failed');
  assert.match(h.get('meta', recordId).error, /Recover saved result again/);
  h.respond(() => complete([{ ...finding, sourceUrl: 'https://example.edu/postings/999' }]));
  await h.sweep.pollSweep(key);
  assert.equal(h.calls.length, before + 1, 'normal polling cannot continue an explicit recovery');
});

test('recovery leaves active jobs to their existing analysis flow', async t => {
  const h = harness(t); await failedResult(h);
  h.put('meta', recordId, { ...h.get('meta', recordId), status: 'running' });
  const before = h.calls.length;
  await h.sweep.recoverSchool(school.id, key);
  assert.equal(h.calls.length, before);
  assert.equal(h.get('meta', recordId).status, 'running');
});

test('one invalid optional application URL cannot discard valid findings or expose credentials', t => {
  const h = harness(t);
  const response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Checked.', checkedSchoolIds: [], completedRequestIds: [], inspectedUrls: [sourceUrl], gaps: [], openings: [{ ...finding, applicationUrl: 'https://private:secret@example.edu/apply' }, finding] }) }] }] };
  const result = h.result.decodeResearch(response);
  assert.equal(result.openings.length, 2);
  assert.equal(result.openings[0].applicationUrl, null);
  assert.equal(result.openings[1].applicationUrl, finding.applicationUrl);
  assert.match(result.gaps[0], /application link omitted/);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const invalidSource = { ...response, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Checked.', checkedSchoolIds: [], completedRequestIds: [], inspectedUrls: [sourceUrl], gaps: [], openings: [{ ...finding, sourceUrl: 'http://example.edu/job' }] }) }] }] };
  assert.throws(() => h.result.decodeResearch(invalidSource), /sourceUrl/);
});

test('application-link warnings preserve a full provider gap list', t => {
  const h = harness(t);
  const gaps = Array.from({ length: 150 }, (_, i) => `Missing source ${i}`);
  const response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ summary: 'Checked.', checkedSchoolIds: [], completedRequestIds: [], inspectedUrls: [sourceUrl], gaps, openings: [{ ...finding, applicationUrl: 'http://example.edu/apply' }] }) }] }] };
  const result = h.result.decodeResearch(response);
  assert.equal(result.openings.length, 1);
  assert.equal(result.openings[0].applicationUrl, null);
  assert.deepEqual(result.gaps.slice(0, 150), gaps);
  assert.match(result.gaps[150], /application link omitted/);
});
