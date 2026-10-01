import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school, applicationUrl, finding } from './helpers/research-harness.mjs';

const key = 'sk-proj-archive-test-not-real';
const saved = (changes = {}) => ({ ...finding, id: 'dismissed', sourceUrl: applicationUrl, applicationUrl,
  workflow: 'Archived', verification: 'AI source check', notes: 'Private note', ...changes });
async function startSchool(h, id = 'archive-test') {
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: applicationUrl }] });
  await h.api.startSchoolResearch(school.id, id, key);
  h.respond(() => complete([{ ...finding, sourceUrl: applicationUrl }], { sourceReviews: [{ url: applicationUrl,
    outcome: 'openings', openingUrls: [applicationUrl], departments: ['CS'], reason: 'The posting advertises CS faculty.' }] }));
}

test('a previously archived posting is skipped without artificial coverage gaps or changes to user data', async t => {
  const h = harness(t);
  h.put('opening', 'dismissed', saved());
  const before = h.get('opening', 'dismissed');
  await startSchool(h); await h.api.pollResearch('archive-test', key);
  assert.deepEqual(h.get('opening', 'dismissed'), before);
  assert.equal(h.count('opening'), 1);
  const job = h.get('meta', 'archive-test');
  assert.equal(job.added, 0); assert.equal(job.updated, 0); assert.equal(job.needsRetry, false);
  assert.match(job.summary, /1 archived findings/);
});

test('posting identity survives renamed titles/departments, tracking parameters, aliases and source/application swaps', t => {
  const h = harness(t), match = h.result.matchesArchivedOpening;
  const harvard = saved({ sourceUrl: 'https://academicpositions.harvard.edu/postings/16834', applicationUrl: 'https://academicpositions.harvard.edu/postings/16840/pre_apply' });
  assert.equal(match(harvard, { ...finding, sourceUrl: 'https://academicpositions.harvard.edu/postings/16840?utm_source=search', applicationUrl: null, title: 'Renamed', department: 'Computer Science' }), true);
  assert.equal(match(saved(), { ...finding, applicationUrl, title: 'A new title', department: 'CS / AI' }), true);
  assert.equal(match(saved({ sourceUrl: 'https://recruit.ucsd.edu/JPF04000', applicationUrl: '' }), { ...finding, sourceUrl: 'https://recruit.ucsd.edu/JPF04000', applicationUrl: null, title: 'Renamed' }), true);
  assert.equal(match(harvard, { ...finding, sourceUrl: 'https://academicpositions.harvard.edu/postings/16834', applicationUrl: null, department: 'CS/AI', title: 'Different display title' }), true);
});

test('different posting IDs, universities and roles on a shared hub remain eligible', t => {
  const h = harness(t), match = h.result.matchesArchivedOpening;
  const old = saved({ sourceUrl: 'https://academicjobsonline.org/ajo/jobs/32272', applicationUrl: 'https://example.edu/apply' });
  assert.equal(match(old, { ...old, sourceUrl: 'https://academicjobsonline.org/ajo/jobs/99999' }), false);
  assert.equal(match(saved(), { ...finding, sourceUrl: applicationUrl, schoolId: 'another-school' }), false);
  assert.equal(match(saved(), { ...finding, sourceUrl: 'https://apply.interfolio.com/98765', applicationUrl: 'https://apply.interfolio.com/98765' }), false);
  assert.equal(match(saved({ sourceUrl: finding.sourceUrl, applicationUrl: 'https://example.edu/apply' }), { ...finding, title: 'Different role', applicationUrl: 'https://example.edu/apply' }), false);
});

test('automatic draft retirement does not suppress a real opening, but a user-dismissed intake does', async t => {
  const h = harness(t), draft = saved({ id: 'draft', schoolId: 'unassigned', verification: 'Draft · research queued', archiveReason: 'resolved-draft' });
  h.put('opening', 'draft', draft);
  assert.equal(h.result.userArchived(draft), false);
  assert.equal(h.result.userArchived({ ...draft, archiveReason: undefined }), false, 'legacy retired drafts are not dismissals');
  await startSchool(h); await h.api.pollResearch('archive-test', key);
  assert.equal(h.records('opening').filter(o => o.workflow === 'Inbox').length, 1);
  assert.equal(h.get('meta', 'archive-test').added, 1);
});

test('a user archive during an active link analysis resolves the request without recreating the inbox entry', async t => {
  const h = harness(t);
  const added = await h.add(applicationUrl, key), requestId = added.request.id;
  await h.workflow.setOpeningWorkflow('intake-' + requestId, 'Archived');
  h.respond(() => complete([{ ...finding, sourceUrl: applicationUrl, sourceRequestId: requestId }], { completedRequestIds: [requestId] }));
  await h.api.pollResearch('research-link-' + requestId, key);
  assert.equal(h.count('opening'), 1); assert.equal(h.records('opening')[0].workflow, 'Archived');
  assert.equal(h.records('opening')[0].archiveReason, 'user');
  assert.equal(h.get('request', requestId).status, 'Researched');
  assert.equal(h.get('meta', 'research-link-' + requestId).needsRetry, false);
});

test('an archive made between reading records and committing the import wins atomically', async t => {
  const h = harness(t);
  const added = await h.add(applicationUrl, key), requestId = added.request.id;
  h.respond(() => complete([{ ...finding, sourceUrl: applicationUrl, sourceRequestId: requestId }], { completedRequestIds: [requestId] }));
  h.hooks.beforeBatch = () => {
    const draft = h.get('opening', 'intake-' + requestId);
    h.put('opening', draft.id, { ...draft, workflow: 'Archived', archiveReason: 'user', notes: 'Latest note' });
  };
  await h.api.pollResearch('research-link-' + requestId, key);
  assert.equal(h.count('opening'), 1, 'the different-ID researched record must not be created');
  assert.equal(h.records('opening')[0].workflow, 'Archived');
  assert.equal(h.records('opening')[0].notes, 'Latest note');
});

test('explicit restoration allows future updates while retaining notes and current research fields', async t => {
  const h = harness(t);
  h.put('opening', 'dismissed', saved({ archiveReason: 'user', materials: 'Latest imported requirements' }));
  await h.workflow.setOpeningWorkflow('dismissed', 'Inbox');
  let restored = h.get('opening', 'dismissed');
  assert.equal(restored.archiveReason, undefined); assert.equal(restored.notes, 'Private note');
  assert.equal(restored.materials, 'Latest imported requirements');
  await startSchool(h); await h.api.pollResearch('archive-test', key);
  assert.equal(h.count('opening'), 1); assert.equal(h.get('meta', 'archive-test').updated, 1);
  restored = h.get('opening', 'dismissed');
  assert.equal(restored.workflow, 'Inbox'); assert.equal(restored.notes, 'Private note');
  await assert.rejects(h.workflow.setOpeningWorkflow('missing', 'Archived'), /not found/);
  await assert.rejects(h.workflow.setOpeningWorkflow('dismissed', 'invalid'), /Invalid/);
});
