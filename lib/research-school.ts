import { hash } from './intake';
import type { School } from './types';
import type { ResearchResult } from './research-result';
import type { SourceReceipt } from './research-source';

const normalizedName = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function institutionMatches(institution: string, school: Pick<School, 'name' | 'shortName'>) {
  const name = normalizedName(institution);
  return [school.name, school.shortName].filter(Boolean).some(value => {
    const candidate = normalizedName(value);
    return candidate.length >= 4 && (name === candidate || name.startsWith(candidate + ' '));
  });
}

// New schools can only come from a complete user-supplied source with an institution
// identity and a link to that institution's domain. Portal hosting alone proves neither.
export async function schoolFromPosting(item: ResearchResult['openings'][number], source?: SourceReceipt): Promise<School | undefined> {
  const proposed = item.newSchool;
  if (!proposed || !source?.readable || !source.complete || !institutionMatches(source.institution || source.title || '', proposed)) return;
  const domain = proposed.domain.toLowerCase().replace(/^www\./, '');
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(domain) || /(?:interfolio\.com|academicjobsonline\.org|myworkdayjobs\.com|peopleadmin\.com|pageuppeople\.com)$/.test(domain)) return;
  if (![source.url, ...(source.links || []).map(l => l.url)].some(url => {
    const host = new URL(url).hostname;
    return host === domain || host.endsWith('.' + domain);
  })) return;
  return { id: 'school-' + await hash(domain), name: proposed.name, shortName: proposed.shortName,
    domain, country: proposed.country, location: proposed.location, departments: [item.department],
    considering: false, notes: '', rankingNote: '', origin: 'Added from a link',
    sources: [{ department: item.department, url: source.url, note: 'Posting supplied for review.' }] };
}
