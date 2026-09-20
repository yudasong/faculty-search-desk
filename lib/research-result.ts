import { z } from 'zod';
import type { Opening, School } from './types';

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
  openings: z.array(z.object({
    schoolId: short, sourceRequestId: short.nullable(), department: short, title: short.min(1),
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
  openings: { type: 'array', items: object({
    schoolId: str, sourceRequestId: nullable, department: str, title: str, sourceUrl: str, applicationUrl: nullable,
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

export function matchesOpening(old: Opening, found: ResearchResult['openings'][number]) {
  if (old.schoolId !== found.schoolId || old.department.toLowerCase() !== found.department.toLowerCase()) return false;
  if (found.applicationUrl && old.applicationUrl) return normalizedUrl(old.applicationUrl) === normalizedUrl(found.applicationUrl);
  return normalizedUrl(old.sourceUrl) === normalizedUrl(found.sourceUrl) && old.title.trim().toLowerCase() === found.title.trim().toLowerCase();
}

export function officialSource(url: string, school: School) {
  const host = new URL(url).hostname.toLowerCase();
  const domains = [school.domain, ...school.sources.map(s => new URL(s.url).hostname), 'apply.interfolio.com', 'academicjobsonline.org', 'myworkdayjobs.com', 'peopleadmin.com', 'pageuppeople.com'];
  return domains.some(d => host === d.toLowerCase() || host.endsWith('.' + d.toLowerCase()));
}

// Null means not established. Never erase previously known requirements or a user's workflow.
export function openingPatch(found: ResearchResult['openings'][number], checkedAt: string) {
  return {
    ...Object.fromEntries(Object.entries(found).filter(([k, v]) => k !== 'sourceRequestId' && v !== null && v !== '' && !(k === 'hiringStatus' && v === 'Unverified'))),
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
