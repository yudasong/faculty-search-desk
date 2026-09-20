import { ArrowUpRight, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Opening } from '@/lib/types';

const formatDate = (date: string) => new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export function SchoolOpenings({ openings, onEdit }: { openings: Opening[]; onEdit: (opening: Opening) => void }) {
  return <section className="school-openings" aria-labelledby="school-openings-heading">
    <h3 id="school-openings-heading">Openings <span className="muted">({openings.length})</span></h3>
    {!openings.length && <p className="school-opening-empty">No openings to show for this school. Check the department sources below or add a hiring link.</p>}
    {openings.map(opening => {
      const primaryDate = opening.deadline || opening.hardDeadline;
      const primaryLabel = opening.deadline && opening.deadlineType && opening.deadlineType !== 'Unknown' ? opening.deadlineType : 'Application deadline';
      return <article className="school-opening-card" key={opening.id} aria-labelledby={'school-opening-' + opening.id}>
        <div className="school-opening-header">
          <span className="tag">{opening.department}</span>
          <span className={'status ' + (opening.hiringStatus === 'Open' ? 'green' : opening.hiringStatus === 'Closed' ? 'gray' : 'amber')}>{opening.hiringStatus === 'Unverified' ? 'Needs verification' : opening.hiringStatus}</span>
        </div>
        <h4 id={'school-opening-' + opening.id}>{opening.title}</h4>
        <p className="school-opening-stage">{opening.workflow === 'Inbox' ? 'In review inbox' : opening.workflow}</p>
        <dl className="school-opening-dates">
          <div><dt>{primaryLabel}</dt><dd>{primaryDate ? <time dateTime={primaryDate}>{formatDate(primaryDate)}</time> : 'Date not verified'}</dd></div>
          {opening.hardDeadline && opening.hardDeadline !== primaryDate && <div><dt>Final closing date</dt><dd><time dateTime={opening.hardDeadline}>{formatDate(opening.hardDeadline)}</time></dd></div>}
        </dl>
        {opening.deadlineText && <p className="school-opening-date-note">{opening.deadlineText}</p>}
        <dl className="school-opening-requirements">
          <div><dt>Required materials</dt><dd>{opening.materials || 'Not stated in the saved record.'}</dd></div>
          <div><dt>Letters / references</dt><dd>{opening.letters || 'Not stated in the saved record.'}</dd></div>
        </dl>
        <div className="school-opening-actions">
          {opening.applicationUrl ? <Button asChild><a href={opening.applicationUrl} target="_blank" rel="noreferrer" aria-label={'Open application for ' + opening.title}>Open application <ArrowUpRight size={16}/></a></Button> : <span className="muted">Application link not verified</span>}
          <a className="school-opening-source" href={opening.sourceUrl} target="_blank" rel="noreferrer" aria-label={'View source for ' + opening.title}>View source <ArrowUpRight size={15}/></a>
          <Button variant="ghost" onClick={() => onEdit(opening)} aria-label={'Edit details for ' + opening.title}><Pencil size={15}/> Edit details</Button>
        </div>
        <p className="school-opening-verification">{opening.verification}{opening.checkedAt && <> · Checked {formatDate(opening.checkedAt)}</>}</p>
      </article>;
    })}
  </section>;
}
