import { normalizedUrl } from './research-result';
import type { ResearchResult } from './research-result';
import type { SourceReceipt } from './research-source';
import { postingPage } from './research-source';

export type DepartmentCheck = { department: string; sourceUrls: string[]; issues: string[] };

// Some university URLs serve the same advertisement under several public IDs.
// Only an explicit Apply link to the same posting-specific form establishes an
// alias; model prose or a common university-wide application hub does not.
export function importedPostingAliases(sources: SourceReceipt[], applicationUrl: string | null) {
  if (!applicationUrl || !/\/postings\/\d+\/pre_apply\/?$/.test(new URL(applicationUrl).pathname)) return [];
  return sources.filter(source => source.method === 'html' && source.readable && source.complete && postingPage(source.url) &&
    source.links?.some(link => /^apply(?:\s+(?:for\s+this\s+(?:job|position)|now|here|online))?$/i.test(link.label.trim()) && normalizedUrl(link.url) === normalizedUrl(applicationUrl)))
    .map(source => source.url);
}

export function assessSchoolCoverage(sources: SourceReceipt[], departments: DepartmentCheck[], reviews: ResearchResult['sourceReviews'], importedUrls: string[], issues: string[]) {
  const gaps = [...issues];
  const imported = new Set(importedUrls.map(normalizedUrl));
  const reviewOf = (source: SourceReceipt) => reviews.find(r => [source.url, source.retrievedUrl].filter(Boolean).some(url => normalizedUrl(r.url) === normalizedUrl(url!)));
  const sourceOf = (url: string) => sources.find(s => [s.url, s.retrievedUrl].filter(Boolean).some(u => normalizedUrl(u!) === normalizedUrl(url)));
  for (const source of sources) {
    if (!source.readable || !source.complete) { gaps.push(`${source.url}: ${source.error || 'Full source content could not be read.'}`); continue; }
    const review = reviewOf(source);
    if (!review) { gaps.push(`${source.url}: source was fetched but its analysis is missing.`); continue; }
    if (review.outcome === 'blocked') gaps.push(`${source.url}: ${review.reason || 'Analysis was blocked.'}`);
    if (!review.reason.trim()) gaps.push(`${source.url}: source assessment has no explanation.`);
    if (review.outcome === 'openings' && !review.openingUrls.length) gaps.push(`${source.url}: openings were reported without individual posting URLs.`);
    if (postingPage(source.url) && !imported.has(normalizedUrl(source.url)) && !(source.retrievedUrl && imported.has(normalizedUrl(source.retrievedUrl))) && review.outcome !== 'irrelevant')
      gaps.push(`${source.url}: an individual posting must be imported or explicitly ruled out; it cannot be treated as an empty hiring page.`);
  }
  for (const review of reviews) {
    if (!sourceOf(review.url)?.readable) gaps.push(`${review.url}: claimed source assessment has no direct reading evidence.`);
    for (const url of review.openingUrls) {
      const source = sourceOf(url);
      if (!source?.readable || !source.complete) gaps.push(`${url}: discovered posting has not been fully read.`);
      else if (!imported.has(normalizedUrl(url)) && !imported.has(normalizedUrl(source.url)) && !(source.retrievedUrl && imported.has(normalizedUrl(source.retrievedUrl)))) {
        const decision = reviewOf(source);
        if (decision?.outcome !== 'irrelevant' || !decision.reason.trim()) gaps.push(`${url}: discovered posting has not been imported or explicitly ruled out.`);
      }
    }
  }
  const departmentKey = (name: string) => name.toLowerCase().replace(/^department of /, '').trim().replace(/^computer science$/, 'cs').replace(/^computer science and engineering$/, 'cse').replace(/^electrical and computer engineering$/, 'ece').replace(/^electrical engineering and computer science$/, 'eecs');
  const resolvedMissing = new Set<string>();
  for (const department of departments) {
    const urls = [...department.sourceUrls, ...reviews.filter(r => r.departments?.some(d => departmentKey(d) === departmentKey(department.department))).map(r => r.url)];
    const assessed = urls.some(url => {
      const source = sourceOf(url), review = source && reviewOf(source);
      return source?.readable && source.complete && review && (review.outcome === 'openings' || (review.outcome === 'no_openings' && !postingPage(source.url)));
    });
    const missing = `No saved hiring source for ${department.department}.`;
    if (assessed) resolvedMissing.add(missing);
    gaps.push(...department.issues.filter(issue => !assessed || issue !== missing));
    if (!assessed) gaps.push(`${department.department}: no complete assessment of an official hiring source.`);
  }
  if (!departments.length || !sources.length) gaps.push('No department hiring sources were assessed.');
  return [...new Set(gaps.filter(gap => !resolvedMissing.has(gap)))];
}
