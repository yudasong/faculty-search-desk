import type { Opening, School } from './types';

function csRank(school: School): number {
  const ranks = (school.rankingSources ?? [])
    .filter(source => source.name.toLowerCase().replace(/\s+/g, '') === 'csrankings')
    .map(source => source.rank)
    .filter((rank): rank is number => typeof rank === 'number' && Number.isFinite(rank) && rank > 0);
  return ranks.length ? Math.min(...ranks) : Infinity;
}

export function orderSchools(schools: School[], openings: Opening[]): School[] {
  const withOpenings = new Set(openings
    .filter(opening => opening.hiringStatus === 'Open' && opening.workflow !== 'Archived')
    .map(opening => opening.schoolId));
  return [...schools].sort((a, b) => {
    const openingOrder = Number(withOpenings.has(b.id)) - Number(withOpenings.has(a.id));
    if (openingOrder) return openingOrder;
    const aRank = csRank(a), bRank = csRank(b);
    if (aRank !== bRank) return aRank - bRank;
    return a.name.localeCompare(b.name);
  });
}
