import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, complete, school, sourceUrl, finding } from './helpers/research-harness.mjs';
const key = 'fixture-freshness-key';

test('date rules separate previous cycles and hard closing from current rolling review', t => {
  const h = harness(t), check = item => h.scope.staleOpeningReason(item, '2026-10-01');
  assert.ok(check({ hiringStatus: 'Closed' }));
  assert.ok(check({ hardDeadline: '2025-12-01' }));
  assert.equal(check({ hardDeadline: '2026-10-01' }), null);
  assert.equal(check({ deadline: '2026-09-03', deadlineType: 'Full consideration', hardDeadline: '2027-07-29' }), null);
  assert.equal(check({ deadline: '2026-09-03', deadlineType: 'Review begins', deadlineText: 'Open until filled' }), null);
  assert.ok(check({ deadline: '2025-12-01', deadlineType: 'Full consideration', deadlineText: 'Open until filled' }));
  assert.ok(check({ title: 'Faculty Positions 2026' }));
  assert.equal(check({ title: 'Faculty Positions 2026–2027' }), null);
  assert.ok(check({ summary: 'Appointment starting Fall 2025.' }));
  assert.equal(h.scope.staleOpeningReason({ deadline: '2025-12-01', deadlineType: 'Review begins' }, '2026-10-01', { openDate: '2026-09-01' }), null);
});

for (const patch of [{ hiringStatus: 'Closed' }, { hardDeadline: '2001-12-01' }, { title: 'Faculty positions 2001' }]) {
  test(`broad search accounts for stale posting without putting it in the inbox: ${JSON.stringify(patch)}`, async t => {
    const h = harness(t);
    h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }] });
    await h.api.startSchoolResearch(school.id, 'freshness', key);
    h.respond(() => complete([{ ...finding, ...patch }], { sourceReviews: [{ url: sourceUrl, outcome: 'openings', openingUrls: [sourceUrl], departments: ['CS'], reason: 'Faculty advertisement.' }] }));
    await h.api.pollResearch('freshness', key);
    assert.equal(h.count('opening'), 0);
    assert.equal(h.get('meta', 'freshness').needsRetry, false);
  });
}

test('explicitly pasted closed posting still imports with truthful status', async t => {
  const h = harness(t);
  h.put('request', 'closed', { id: 'closed', url: sourceUrl, status: 'Queued' });
  await h.api.startResearch('link', 'closed', false, key);
  h.respond(() => complete([{ ...finding, sourceRequestId: 'closed', hiringStatus: 'Closed', hardDeadline: '2001-12-01' }], { completedRequestIds: ['closed'] }));
  await h.api.pollResearch('research-link-closed', key);
  assert.equal(h.count('opening'), 1);
  assert.equal(h.records('opening')[0].hiringStatus, 'Closed');
});

test('current review evidence outranks an ambiguous title year and full appointment dates parse', t => {
  const h = harness(t);
  assert.equal(h.scope.staleOpeningReason({ title: 'Faculty Search 2026', deadline: '2026-11-15', deadlineType: 'Full consideration' }, '2026-10-01'), null);
  assert.ok(h.scope.staleOpeningReason({ summary: 'Appointment begins July 1, 2025.' }, '2026-10-01'));
});

test('excluding a stale hub entry cannot erase another unread candidate from coverage', async t => {
  const h = harness(t);
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }] });
  await h.api.startSchoolResearch(school.id, 'freshness', key);
  h.put('meta', 'freshness', { ...h.get('meta', 'freshness'), verificationPass: true });
  h.respond(() => complete([{ ...finding, hiringStatus: 'Closed' }], { sourceReviews: [{ url: sourceUrl, outcome: 'openings', openingUrls: [sourceUrl, 'https://example.edu/postings/9876'], departments: ['CS'], reason: 'Two candidates.' }] }));
  await h.api.pollResearch('freshness', key);
  assert.equal(h.get('meta', 'freshness').needsRetry, true);
  assert.match(h.get('meta', 'freshness').coverageIssues.join(' '), /9876/);
});

test('a live hiring hub cannot resurrect its uniquely linked closed portal posting', async t => {
  const { applicationUrl } = await import('./helpers/research-harness.mjs');
  const h = harness(t);
  h.put('school', school.id, { ...school, sources: [{ department: 'CS', url: sourceUrl }] });
  await h.api.startSchoolResearch(school.id, 'freshness', key);
  const job = h.get('meta', 'freshness');
  job.sources[0].links = [{ label: 'Apply here', url: applicationUrl }];
  job.sources.push({ ...job.sources[0], url: applicationUrl, retrievedUrl: 'https://logic.interfolio.com/dossier-api/positions/12345', title: finding.title, status: 'Closed', method: 'interfolio', readable: true, complete: true });
  job.verificationPass = true;
  h.put('meta', 'freshness', job);
  h.respond(() => complete([{ ...finding, applicationUrl: null, hiringStatus: 'Open' }], { sourceReviews: [{ url: sourceUrl, outcome: 'openings', openingUrls: [sourceUrl], departments: ['CS'], reason: 'Hub advertises a hire.' }, { url: applicationUrl, outcome: 'irrelevant', openingUrls: [], departments: ['CS'], reason: 'Closed prior cycle.' }] }));
  await h.api.pollResearch('freshness', key);
  assert.equal(h.count('opening'), 0);
  assert.equal(h.get('meta', 'freshness').needsRetry, false);
});

test('date-only deadlines do not expire during the deadline evening in US time zones', t => {
  const h = harness(t);
  const day = h.scope.researchCalendarDate(new Date('2026-10-02T01:00:00Z'));
  assert.equal(day, '2026-10-01');
  assert.equal(h.scope.staleOpeningReason({ hardDeadline: '2026-10-01' }, day), null);
  assert.ok(h.scope.staleOpeningReason({ hardDeadline: '2026-09-30' }, day));
});
