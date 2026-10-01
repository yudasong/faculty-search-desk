import { z } from 'zod';
import type { Opening, School } from './types';
import { individualPosting, postingPage, samePosting } from './research-source';

const text = z.string().max(12000);
const short = z.string().max(500);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const https = z.string().max(2500).url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.port;
});
export const researchResult = z.object({
  summary: text,
  checkedSchoolIds: z.array(short).max(150),
  completedRequestIds: z.array(short).max(100),
  inspectedUrls: z.array(https).max(300),
  gaps: z.array(text).max(150),
  sourceReviews: z.array(z.object({ url: https, outcome: z.enum(['openings', 'no_openings', 'irrelevant', 'blocked']), openingUrls: z.array(https).max(100), departments: z.array(short).max(20).default([]), reason: text }).strict()).max(100).default([]),
  openings: z.array(z.object({
    schoolId: short, sourceRequestId: short.nullable(), department: short, title: short.min(1),
    newSchool: z.object({ name: short.min(1), shortName: short.min(1), domain: short.min(1), country: short, location: short }).strict().nullable().default(null),
    location: short.nullable().default(null),
    scopeEvidence: z.object({ area: z.enum(['CS', 'AI', 'ML', 'Statistics', 'Data Science']), quote: z.string().max(1500), reason: short }).strict().nullable().default(null),
    sourceUrl: https, applicationUrl: https.nullable(),
    deadline: date, deadlineType: short.nullable(), deadlineText: text.nullable(),
    hardDeadline: date, rank: short.nullable(), areas: text.nullable(),
    materials: text.nullable(), letters: short.nullable(), summary: text,
    hiringStatus: z.enum(['Open', 'Closed', 'Unverified']),
  }).strict()).max(100),
}).strict();
export type ResearchResult = z.infer<typeof researchResult>;

const str = { type: 'string' };
const nullable = { type: ['string', 'null'] };
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const resultJsonSchema = object({
  summary: str,
  checkedSchoolIds: { type: 'array', items: str },
  completedRequestIds: { type: 'array', items: str },
  inspectedUrls: { type: 'array', items: str },
  gaps: { type: 'array', items: str },
  sourceReviews: { type: 'array', items: object({ url: str, outcome: { type: 'string', enum: ['openings', 'no_openings', 'irrelevant', 'blocked'] }, openingUrls: { type: 'array', items: str }, departments: { type: 'array', items: str }, reason: str }) },
  openings: { type: 'array', items: object({
    schoolId: str, sourceRequestId: nullable, department: str, title: str, sourceUrl: str, applicationUrl: nullable,
    newSchool: { anyOf: [object({ name: str, shortName: str, domain: str, country: str, location: str }), { type: 'null' }] },
    location: nullable,
    scopeEvidence: { anyOf: [object({ area: { type: 'string', enum: ['CS', 'AI', 'ML', 'Statistics', 'Data Science'] }, quote: str, reason: str }), { type: 'null' }] },
    deadline: nullable, deadlineType: nullable, deadlineText: nullable, hardDeadline: nullable,
    rank: nullable, areas: nullable, materials: nullable, letters: nullable, summary: str,
    hiringStatus: { type: 'string', enum: ['Open', 'Closed', 'Unverified'] },
  }) },
});

export function normalizedUrl(value: string) {
  const u = new URL(value); u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k);
  u.searchParams.sort(); return u.toString();
}

export function departmentName(value: string, school: School) {
  const aliases: Record<string, string> = {
    'computer science': 'CS', 'computer science and engineering': 'CSE',
    'electrical and computer engineering': 'ECE', 'electrical engineering and computer science': 'EECS',
  };
  const canonical = aliases[value.toLowerCase().trim()] || value.trim();
  return school.departments.find(d => d.toLowerCase() === canonical.toLowerCase()) || canonical;
}

type OpeningIdentity = Pick<Opening, 'schoolId' | 'department' | 'title' | 'sourceUrl'> & { applicationUrl?: string | null };
function postingIdentity(value?: string | null) {
  if (!value) return '';
  const url = new URL(normalizedUrl(value));
  if (!postingPage(value) && !/\/(?:JPF|REQ[_-]?|R)\d+(?:\/|$)/i.test(url.pathname)) return '';
  url.pathname = url.pathname.replace(/\/pre_apply\/?$/, '').replace(/\/$/, '');
  if (individualPosting(value)) url.search = '';
  return url.toString();
}

export function matchesOpening(old: OpeningIdentity, found: OpeningIdentity) {
  if (old.schoolId !== found.schoolId) return false;
  const oldSource = postingIdentity(old.sourceUrl), newSource = postingIdentity(found.sourceUrl);
  if (oldSource && oldSource === newSource) return true;
  // Different IDs at the same portal are separate advertisements, even when
  // both point at a generic university-wide Apply page.
  if (individualPosting(old.sourceUrl) && individualPosting(found.sourceUrl) && new URL(old.sourceUrl).hostname === new URL(found.sourceUrl).hostname)
    return samePosting(old.sourceUrl, found.sourceUrl);
  const oldApply = postingIdentity(old.applicationUrl), newApply = postingIdentity(found.applicationUrl);
  if ((oldApply && (oldApply === newSource || oldApply === newApply)) || (newApply && newApply === oldSource)) return true;
  if (oldSource && newSource) return false;
  if (old.department.toLowerCase() !== found.department.toLowerCase()) return false;
  const sameTitle = old.title.trim().toLowerCase() === found.title.trim().toLowerCase();
  return sameTitle && (normalizedUrl(old.sourceUrl) === normalizedUrl(found.sourceUrl) ||
    (!!old.applicationUrl && !!found.applicationUrl && normalizedUrl(old.applicationUrl) === normalizedUrl(found.applicationUrl)));
}

export function userArchived(opening: Opening) {
  // Successful link analysis also archives its temporary draft. Those records
  // are bookkeeping, not a request to hide the resulting faculty positions.
  return opening.workflow === 'Archived' && (opening.archiveReason === 'user' ||
    (opening.archiveReason !== 'resolved-draft' && !opening.verification?.startsWith('Draft')));
}

export function matchesArchivedOpening(old: Opening, found: OpeningIdentity) {
  if (old.verification?.startsWith('Draft')) {
    // A user can dismiss an intake card while its analysis is still running.
    // Only an exact individual posting is a blanket dismissal, never a hub.
    return !!postingIdentity(old.sourceUrl) && postingIdentity(old.sourceUrl) === postingIdentity(found.sourceUrl) &&
      (old.schoolId === found.schoolId || old.schoolId === 'unassigned');
  }
  return matchesOpening(old, found);
}

export function officialSource(url: string, school: School) {
  const host = new URL(url).hostname.toLowerCase();
  const domains = [school.domain, ...school.sources.map(s => new URL(s.url).hostname), 'apply.interfolio.com', 'academicjobsonline.org', 'myworkdayjobs.com', 'peopleadmin.com', 'pageuppeople.com'];
  return domains.some(d => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}

// Null means not established. Never erase previously known requirements or a user's workflow.
export function openingPatch(found: ResearchResult['openings'][number], checkedAt: string) {
  return {
    ...Object.fromEntries(Object.entries(found).filter(([k, v]) => !['sourceRequestId', 'newSchool', 'scopeEvidence'].includes(k) && v !== null && v !== '' && !(k === 'hiringStatus' && v === 'Unverified'))),
    checkedAt, verification: 'AI source check · review details', sourceKind: 'On-demand API research',
  };
}

export function decodeResearch(response: any) {
  if (response.status !== 'completed') throw new Error('Research did not finish. No findings were imported.');
  const content = (response.output || []).filter((x: any) => x.type === 'message').flatMap((x: any) => x.content || []);
  if (content.some((x: any) => x.type === 'refusal')) throw new Error('The research provider could not complete this request. No findings were imported.');
  const output = content.filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('');
  try { return researchResult.parse(JSON.parse(output)); }
  catch { throw new Error('The research result was incomplete or invalid. No findings were imported.'); }
}

export function providerSourceUrls(response: any): Set<string> {
  const urls: string[] = [];
  for (const item of response.output || []) {
    if (item.type === 'web_search_call') {
      if (item.action?.url) urls.push(item.action.url);
      for (const source of item.action?.sources || []) if (source.url) urls.push(source.url);
    }
    for (const part of item.content || []) for (const a of part.annotations || []) if (a.type === 'url_citation' && a.url) urls.push(a.url);
  }
  return new Set(urls.flatMap(u => { try { return [normalizedUrl(u)]; } catch { return []; } }));
}
