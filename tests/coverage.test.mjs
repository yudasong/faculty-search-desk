import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, finding, sourceUrl, applicationUrl } from './helpers/research-harness.mjs';

const receipt = (url, extra = {}) => ({
  requestId: url, url, retrievedAt: '2026-09-28T12:00:00Z',
  method: 'html', readable: true, complete: true, ...extra,
});
const department = (urls = [sourceUrl], extra = {}) => ({ department: 'CS', sourceUrls: urls, issues: [], ...extra });
const review = (url, extra = {}) => ({
  url, outcome: 'no_openings', openingUrls: [], departments: ['CS'],
  reason: 'The complete hiring index lists no current faculty searches.', ...extra,
});

test('a claimed source review cannot establish coverage without a complete direct reading', t => {
  const { coverage } = harness(t);
  for (const sources of [[], [receipt(sourceUrl, { readable: false, complete: false })], [receipt(sourceUrl, { complete: false })]]) {
    const gaps = coverage.assessSchoolCoverage(sources, [department()], [review(sourceUrl)], [], []);
    assert.ok(gaps.some(gap => gap.includes('CS: no complete assessment')), JSON.stringify(sources));
  }
});

test('fetching a hiring index without analyzing it does not count as verified coverage', t => {
  const { coverage } = harness(t);
  const gaps = coverage.assessSchoolCoverage([receipt(sourceUrl)], [department()], [], [], []);
  assert.ok(gaps.some(gap => gap.includes('analysis is missing')));
  assert.ok(gaps.some(gap => gap.includes('CS: no complete assessment')));
});

test('individual Open postings cannot disappear behind a no-openings assessment', t => {
  const { coverage } = harness(t);
  for (const [url, method] of [[applicationUrl, 'interfolio'], ['https://academicjobsonline.org/ajo/jobs/32272', 'ajo']]) {
    const gaps = coverage.assessSchoolCoverage(
      [receipt(url, { method, status: 'Open', title: 'Tenure-track faculty' })],
      [department([url])], [review(url)], [], [],
    );
    assert.ok(gaps.some(gap => gap.includes('individual posting must be imported')), method);
    assert.ok(gaps.some(gap => gap.includes('CS: no complete assessment')), method);
  }
});

test('discovered postings require an import or a documented relevance decision', t => {
  const { coverage } = harness(t);
  const sources = [receipt(sourceUrl), receipt(applicationUrl, { method: 'interfolio' })];
  const hubReview = review(sourceUrl, { outcome: 'openings', openingUrls: [applicationUrl], reason: 'The hiring index links to one faculty posting.' });
  const postingReview = review(applicationUrl, { outcome: 'openings', openingUrls: [applicationUrl], reason: 'This is a current computer science faculty search.' });
  const assess = (reviews, imports) => coverage.assessSchoolCoverage(sources, [department()], reviews, imports, []);
  assert.ok(assess([hubReview, postingReview], []).some(gap => gap.includes('not been imported or explicitly ruled out')));
  assert.deepEqual(assess([hubReview, postingReview], [applicationUrl]), []);
  assert.deepEqual(assess([hubReview, review(applicationUrl, { outcome: 'irrelevant', reason: 'The advertised appointment is a postdoctoral fellowship outside the requested faculty roles.' })], []), []);
  assert.ok(assess([hubReview, review(applicationUrl, { outcome: 'irrelevant', reason: ' ' })], []).length > 0);
});

test('reviews of a fetched redirect destination satisfy the original hiring source', t => {
  const { coverage } = harness(t);
  const redirected = 'https://example.edu/cs/faculty-careers';
  const gaps = coverage.assessSchoolCoverage(
    [receipt(sourceUrl, { retrievedUrl: redirected })], [department()],
    [review(redirected + '?utm_source=search')], [], [],
  );
  assert.deepEqual(gaps, []);
});

test('a posting imported under its fetched redirect URL satisfies an original candidate URL', t => {
  const { coverage } = harness(t);
  const original = 'https://academicpositions.harvard.edu/postings/16834';
  const redirected = 'https://academicpositions.harvard.edu/postings/16840';
  const gaps = coverage.assessSchoolCoverage(
    [receipt(sourceUrl), receipt(original, { retrievedUrl: redirected })], [department()],
    [review(sourceUrl, { outcome: 'openings', openingUrls: [original], reason: 'The index advertises one faculty opening.' }),
      review(redirected, { outcome: 'openings', openingUrls: [redirected], reason: 'The full posting is a current CS faculty search.' })],
    [redirected], [],
  );
  assert.deepEqual(gaps, []);
});

test('a newly fetched department hiring source resolves only its missing-source issue', t => {
  const { coverage } = harness(t);
  const missing = 'No saved hiring source for CS.';
  const departments = [department([], { issues: [missing] })];
  const reviews = [review(sourceUrl, { departments: ['Department of Computer Science'] })];
  const assess = (sources, issues) => coverage.assessSchoolCoverage(sources, departments, reviews, [], issues);
  assert.deepEqual(assess([receipt(sourceUrl)], [missing]), []);
  assert.deepEqual(assess([receipt(sourceUrl)], [missing, 'A second hiring page could not be read.']), ['A second hiring page could not be read.']);
  assert.ok(assess([receipt(sourceUrl, { complete: false })], [missing]).includes(missing));
});

test('an unrelated department assessment cannot resolve the CS source gap', t => {
  const { coverage } = harness(t);
  const missing = 'No saved hiring source for CS.';
  const gaps = coverage.assessSchoolCoverage(
    [receipt(sourceUrl)], [department([], { issues: [missing] })],
    [review(sourceUrl, { departments: ['ECE'] })], [], [missing],
  );
  assert.ok(gaps.includes(missing));
  assert.ok(gaps.some(gap => gap.includes('CS: no complete assessment')));
});

test('Harvard aliases sharing a posting-specific application update one opening', t => {
  const { result } = harness(t);
  const old = { ...finding, schoolId: 'harvard', sourceUrl: 'https://academicpositions.harvard.edu/postings/16834', applicationUrl: 'https://academicpositions.harvard.edu/postings/16840/pre_apply' };
  const found = { ...old, sourceUrl: 'https://academicpositions.harvard.edu/postings/16840', department: 'Computer Science', title: 'Updated faculty search title' };
  assert.equal(result.matchesOpening(old, found), true);
  assert.equal(result.matchesOpening(found, old), true);
  assert.equal(result.matchesOpening(old, { ...found, schoolId: 'other' }), false);
});

test('separate AJO advertisements sharing a generic Apply hub remain separate', t => {
  const { result } = harness(t);
  const old = { ...finding, schoolId: 'eth', sourceUrl: 'https://academicjobsonline.org/ajo/jobs/32272', applicationUrl: 'https://ethz.ch/en/faculty.html' };
  const other = { ...old, sourceUrl: 'https://academicjobsonline.org/ajo/jobs/99999' };
  assert.equal(result.matchesOpening(old, other), false);
  assert.equal(result.matchesOpening(other, old), false);
  assert.equal(result.matchesOpening(old, { ...old, department: 'CS / Mathematics', applicationUrl: 'https://ethz.ch/en/updated-faculty.html' }), true);
});


test('an individual university-portal ad cannot be called an empty hiring index', t => {
  const h = harness(t);
  const url = 'https://academicpositions.harvard.edu/postings/16840';
  const source = { url, requestId: 'h', retrievedAt: '2026-09-28', method: 'html', readable: true, complete: true };
  const gaps = h.coverage.assessSchoolCoverage([source], [{ department: 'CS', sourceUrls: [url], issues: [] }], [{ url, outcome: 'no_openings', openingUrls: [], departments: ['CS'], reason: 'No openings.' }], [], []);
  assert.match(gaps.join(' '), /individual posting must be imported/);
});

test('duplicate university ad aliases need a directly read, posting-specific Apply link', t => {
  const h = harness(t), apply = 'https://academicpositions.harvard.edu/postings/16840/pre_apply';
  const source = { url: 'https://academicpositions.harvard.edu/postings/16836', method: 'html', readable: true, complete: true, links: [{ label: 'Apply for this Job', url: apply }] };
  assert.deepEqual(h.coverage.importedPostingAliases([source], apply), [source.url]);
  assert.deepEqual(h.coverage.importedPostingAliases([{ ...source, complete: false }], apply), []);
  assert.deepEqual(h.coverage.importedPostingAliases([{ ...source, links: [{ label: 'Other job', url: apply }] }], apply), []);
  assert.deepEqual(h.coverage.importedPostingAliases([{ ...source, links: [{ label: 'Apply now', url: 'https://harvard.edu/apply' }] }], 'https://harvard.edu/apply'), []);
});
