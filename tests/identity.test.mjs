import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, finding } from './helpers/research-harness.mjs';

test('direct portal and hub-to-portal findings have the same deterministic ID key', t => {
  const h = harness(t);
  const direct = { ...finding, sourceUrl: 'https://apply.interfolio.com/193699', applicationUrl: 'https://apply.interfolio.com/193699' };
  const hub = { ...direct, sourceUrl: 'https://example.edu/employment', department: 'Computer Science', title: 'Renamed heading' };
  assert.equal(h.result.openingIdentityKey(direct), h.result.openingIdentityKey(hub));
  assert.notEqual(h.result.openingIdentityKey(direct), h.result.openingIdentityKey({ ...direct, sourceUrl: 'https://apply.interfolio.com/174597' }));
});

test('a posting-specific slug tolerates title drift and department acronym suffixes are harmless', t => {
  const h = harness(t);
  const old = { ...finding, sourceUrl: 'https://example.edu/faculty-positions/ai-chair', applicationUrl: null };
  assert.ok(h.result.matchesOpening(old, { ...old, title: 'Endowed Chair in Artificial Intelligence' }));
  const hub = { ...finding, department: 'Mathematics, Statistics and Computer Science', applicationUrl: null };
  assert.ok(h.result.matchesOpening(hub, { ...hub, department: hub.department + ' (MSCS)' }));
  assert.equal(h.result.matchesOpening(hub, { ...hub, title: 'Different search' }), false);
  assert.equal(h.result.matchesOpening(old, { ...old, sourceUrl: 'https://example.edu/faculty-positions/ai-chair-2027' }), false);
});

test('different portal IDs and role-specific query parameters are not merged', t => {
  const h = harness(t);
  const first = { ...finding, sourceUrl: 'https://academicjobsonline.org/ajo/jobs/32102', applicationUrl: 'https://example.edu/apply' };
  assert.equal(h.result.matchesOpening(first, { ...first, sourceUrl: 'https://academicjobsonline.org/ajo/jobs/32272' }), false);
  assert.notEqual(h.result.openingIdentityKey(first), h.result.openingIdentityKey({ ...first, sourceUrl: 'https://academicjobsonline.org/ajo/jobs/32272' }));
  assert.notEqual(h.result.openingIdentityKey({ ...finding, applicationUrl: 'https://example.edu/apply?track=faculty' }), h.result.openingIdentityKey({ ...finding, applicationUrl: 'https://example.edu/apply?track=rap' }));
});

test('category hubs and different campuses cannot be collapsed by title normalization', t => {
  const h = harness(t);
  const category = { ...finding, sourceUrl: 'https://example.edu/faculty-positions/computer-science', applicationUrl: null };
  assert.equal(h.result.matchesOpening(category, { ...category, title: 'Teaching Professor of CS' }), false);
  assert.notEqual(h.result.openingIdentityKey(category), h.result.openingIdentityKey({ ...category, title: 'Teaching Professor of CS' }));
  const london = { ...category, department: 'Computer Science (London)' }, oxford = { ...category, department: 'Computer Science (Oxford)' };
  assert.equal(h.result.matchesOpening(london, oxford), false);
  assert.notEqual(h.result.openingIdentityKey(london), h.result.openingIdentityKey(oxford));
  assert.equal(h.result.openingIdentityKey({ ...category, department: 'Computer  Science (CS)' }), h.result.openingIdentityKey({ ...category, department: 'Computer Science' }));
});

test('simultaneous hub and portal imports commit one opening while retaining workflow', async t => {
  const { school, sourceUrl, applicationUrl, complete } = await import('./helpers/research-harness.mjs');
  const h = harness(t), key = 'fixture-concurrent-identity';
  h.put('request', 'hub', { id: 'hub', url: sourceUrl, status: 'Queued' });
  h.put('request', 'portal', { id: 'portal', url: applicationUrl, status: 'Queued' });
  let next = 0;
  h.respond(call => call.method === 'POST' ? Response.json({ id: `resp_${++next}`, status: 'queued' }) : complete());
  await h.api.startResearch('link', 'hub', false, key);
  await h.api.startResearch('link', 'portal', false, key);
  const hubResponseId = h.get('meta', 'research-link-hub').responseId;
  let release; const barrier = new Promise(resolve => { release = resolve; }); let arrivals = 0;
  h.respond(async call => {
    if (++arrivals === 2) release();
    await barrier;
    const hub = call.url.endsWith(hubResponseId), requestId = hub ? 'hub' : 'portal';
    return complete([{ ...finding, schoolId: school.id, sourceRequestId: requestId, sourceUrl: hub ? sourceUrl : applicationUrl, applicationUrl, department: hub ? 'Computer Science' : 'CS' }], { completedRequestIds: [requestId], inspectedUrls: [sourceUrl, applicationUrl] });
  });
  await Promise.all([h.api.pollResearch('research-link-hub', key), h.api.pollResearch('research-link-portal', key)]);
  assert.equal(h.count('opening'), 1);
  assert.equal(h.records('opening')[0].workflow, 'Inbox');
  assert.equal(h.get('request', 'hub').status, 'Researched');
  assert.equal(h.get('request', 'portal').status, 'Researched');
});

test('Northwestern application IDs unify descriptions without merging separate applications', t => {
  const h = harness(t);
  const old = { ...finding, applicationUrl: 'https://facultyrecruiting.northwestern.edu/apply/MjYzMw==' };
  const renamed = { ...old, title: 'Assistant or Associate Professor', department: 'Computer Science' };
  assert.ok(h.result.matchesOpening(old, renamed));
  assert.equal(h.result.openingIdentityKey(old), h.result.openingIdentityKey(renamed));
  assert.notEqual(h.result.openingIdentityKey(old), h.result.openingIdentityKey({ ...old, applicationUrl: 'https://facultyrecruiting.northwestern.edu/apply/MjYzNA==' }));
});
