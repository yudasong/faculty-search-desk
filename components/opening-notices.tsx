import type { Opening } from '@/lib/types';
import { discoveryExclusionReason, staleOpeningReason } from '@/lib/research-scope';

export function OpeningNotices({ opening }: { opening: Opening }) {
  const stale = staleOpeningReason(opening);
  const outside = discoveryExclusionReason(opening);
  if (!stale && !outside) return null;
  return <div className="opening-notices">
    {stale && <p>{stale}</p>}
    {outside && <p>Outside your current search scope. This saved entry is retained until you archive it.</p>}
  </div>;
}
