'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar, RefreshCw, AlertCircle, Check, KeyRound, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { RESEARCH_AREA_LABEL } from '@/lib/research-scope';
import { browserApiKey, keyChangedEvent, researchFetch } from '@/lib/browser-api-key';

type SchoolProgress = { canRecover?: boolean; schoolId: string; attempt: number; name: string; status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'blocked'; summary?: string; issues?: string[]; sources?: { url: string; readable: boolean; complete: boolean; error?: string }[]; added?: number; updated?: number };
type Job = { id: string; status: string; summary: string; error?: string; added?: number; updated?: number; gaps?: number; needsRetry?: boolean; schoolCount: number; requestId?: string; sourceUrl?: string; schools?: SchoolProgress[]; completedSchools?: number; totalSchools?: number; legacyCoverage?: boolean };
type State = { configured: boolean; job: Job | null; links: Job[]; errors?: string[] };
const schoolStatus: Record<SchoolProgress['status'], string> = { pending: 'Waiting', running: 'Searching', completed: 'Coverage complete', partial: 'Coverage gaps', failed: 'Failed', blocked: 'Needs attention' };
function sourceHost(value?: string) { try { return value ? new URL(value).hostname : 'Saved link'; } catch { return value || 'Saved link'; } }
export function ResearchControl({ considering, total, inboxCount, schools = [], revision, onConfigured, onComplete, onOpenKeySettings }: { considering: number; total: number; queued: number; inboxCount: number; schools?: { id: string; name: string }[]; revision: number; onConfigured: (value: boolean) => void; onComplete: () => Promise<unknown>; onOpenKeySettings: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false), [scope, setScope] = useState('considering');
  const [selectedSchool, setSelectedSchool] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const completed = useRef(new Set<string>());
  const credentialVersion = useRef(0);
  const controlVersion = useRef(0);
  const running = state?.job?.status === 'starting' || state?.job?.status === 'running';
  const paused = state?.job?.status === 'paused';
  const linkRunning = state?.links.some(j => ['starting', 'running'].includes(j.status));
  const job = state?.job;
  const legacyCoverage = !!job?.legacyCoverage;
  const verifiedSchools = job?.completedSchools ?? job?.schools?.filter(school => school.status === 'completed').length ?? 0;
  const totalSchools = job?.totalSchools ?? job?.schools?.length ?? job?.schoolCount ?? 0;
  const processedSchools = job?.schools?.filter(school => ['completed', 'partial', 'failed'].includes(school.status)).length ?? 0;
  const waitingSchools = job?.schools?.filter(school => school.status === 'pending').length ?? 0;
  const partialSchools = job?.schools?.filter(school => school.status === 'partial').length ?? 0;
  const failedSchools = job?.schools?.filter(school => school.status === 'failed').length ?? 0;
  const coverageGaps = !!job && (legacyCoverage || job.needsRetry || ['failed', 'blocked'].includes(job.status) || job.schools?.some(school => ['partial', 'failed', 'blocked'].includes(school.status)) || (job.status === 'completed' && verifiedSchools < totalSchools));
  const coverageLabel = legacyCoverage ? 'Previous search coverage is unverified.' : `${partialSchools} with coverage gaps; ${failedSchools} failed.`;
  const request = useCallback(async (body?: unknown) => {
    const version = credentialVersion.current;
    const control = controlVersion.current;
    const response = await researchFetch('/api/research', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json() as State & { error?: string }; if (!response.ok) throw new Error(result.error || 'Search is temporarily unavailable.');
    if (version !== credentialVersion.current || control !== controlVersion.current) return result;
    setState(result); setError(result.errors?.join(' ') || ''); onConfigured(result.configured);
    const finished = [result.job, ...result.links].filter((j): j is Job => !!j && j.status === 'completed').map(j => j.id);
    for (const school of result.job?.schools || []) {
      if (['completed', 'partial', 'failed', 'blocked'].includes(school.status)) finished.push(`${result.job!.id}:${school.schoolId}:${school.attempt}:${school.status}:${school.added || 0}:${school.updated || 0}`);
    }
    const newlyFinished = finished.filter(id => !completed.current.has(id));
    if (newlyFinished.length) { await onComplete(); newlyFinished.forEach(id => completed.current.add(id)); }
    return result as State;
  }, [onComplete, onConfigured]);
  useEffect(() => {
    const changed = () => { credentialVersion.current++; request(browserApiKey() ? { action: 'poll' } : undefined).catch(e => setError(e.message)); };
    window.addEventListener(keyChangedEvent, changed); window.addEventListener('storage', changed);
    return () => { window.removeEventListener(keyChangedEvent, changed); window.removeEventListener('storage', changed); };
  }, [request]);
  useEffect(() => { request().catch(e => setError(e.message)); }, [request, revision]);
  useEffect(() => {
    if ((!running && !linkRunning) || !state?.configured) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await request({ action: 'poll' }); } catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(poll, 8000);
    }
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, linkRunning, state?.configured, request]);
  async function start() {
    setBusy(true); setError('');
    try { await request({ action: 'start', scope: scope === 'selected' ? 'considering' : scope, ...(scope === 'selected' ? { schoolIds: [selectedSchool] } : {}) }); setOpen(false); }
    catch (e) { setError((e as Error).message); await request().catch(() => {}); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function retrySchools(schoolId?: string) {
    setBusy(true); setError('');
    try { await request(schoolId ? { action: 'retry_school', schoolId } : { action: 'retry_incomplete' }); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function changePaused(action: 'pause' | 'resume') {
    controlVersion.current++; setBusy(true); setError('');
    try { await request({ action }); setOpen(false); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function analyze(requestId?: string) {
    setBusy(true); setError('');
    try { await request({ action: 'analyze', requestId }); }
    catch (e) {
      const message = (e as Error).message;
      const fresh = await request().catch(() => null);
      // The saved job already displays its failure. Avoid a duplicate banner
      // and ensure a failed retry replaces the previous, stale error message.
      if (!fresh?.links.some(job => job.requestId === requestId && job.error === message)) setError(message);
    } finally { setBusy(false); }
  }
  const linkStatus = (job: Job) => <div key={job.id} className={'search-progress' + (job.status === 'failed' ? ' has-error' : '')} role="status">
    {['starting', 'running'].includes(job.status) ? <RefreshCw size={17} className="search-spinner"/> : job.status === 'completed' && !job.needsRetry ? <Check size={17}/> : <AlertCircle size={17}/>}
    <span><a href={job.sourceUrl} target="_blank" rel="noreferrer">{sourceHost(job.sourceUrl)}</a>: {job.error || (job.status === 'completed' ? `${job.needsRetry ? 'Analysis finished with gaps.' : 'Analysis complete.'} ${job.added || 0} new, ${job.updated || 0} updated openings.${job.gaps ? ' Review coverage issues in Research history.' : ' Saved entries updated.'}` : 'AI is reading the page and its application links…')}</span>
    {(job.status === 'failed' || job.status === 'completed') && <Button variant="ghost" size="sm" disabled={busy || !state?.configured} onClick={() => analyze(job.requestId)}>{job.status === 'completed' && !job.needsRetry ? 'Re-analyze' : 'Retry analysis'}</Button>}
    {job.status === 'blocked' && <><Button variant="ghost" size="sm" disabled={!state?.configured} onClick={() => request({ action: 'poll' }).catch(e => setError(e.message))}>Retry status</Button><Button variant="ghost" size="sm" onClick={() => request({ action: 'stop_tracking', requestId: job.requestId }).catch(e => setError(e.message))}>Stop tracking</Button></>}
  </div>;
  const recentLinks = state?.links.filter(job => job.status === 'completed' && !job.needsRetry).slice(0, 3) || [];
  return <>
    <div className="research-control">
      {paused ? <Button variant="outline" disabled={busy} onClick={() => state?.configured ? changePaused('resume') : onOpenKeySettings()}><Play size={17}/>{busy ? 'Resuming…' : 'Resume search'}</Button> : <Button variant="outline" onClick={() => setOpen(true)}><Radar size={17}/>{running ? 'Search in progress' : 'Search now'}</Button>}
      {running && !!job?.schools?.length && <Button variant="outline" disabled={busy} onClick={() => changePaused('pause')}><Pause size={17}/> Pause search</Button>}
      <Button variant="ghost" onClick={onOpenKeySettings}><KeyRound size={16}/> API key</Button>
      {state && !state.configured && <span className="search-meta">API setup needed</span>}
    </div>
    {(running || error || job) && <div className={'search-progress search-overview' + (error || job?.status === 'blocked' || job?.status === 'failed' ? ' has-error' : !paused && coverageGaps ? ' has-gaps' : '')} role="status">
      {paused ? <Pause size={17}/> : running ? <RefreshCw size={17} className="search-spinner"/> : job?.status === 'completed' && !coverageGaps ? <Check size={17}/> : <AlertCircle size={17}/>}
      <span>{error || (paused ? `Search paused. ${processedSchools}/${totalSchools} schools processed; ${waitingSchools} waiting. Progress is saved.` : job?.error || (running ? `Searching school by school. ${processedSchools}/${totalSchools} schools processed.` : job?.status === 'completed' ? `${coverageGaps ? 'Search finished with gaps.' : 'Search complete.'} ${job.schools ? `${processedSchools}/${totalSchools} schools processed. ` : ''}${coverageLabel}` : job?.summary))}{job?.status === 'completed' && <small>Results are saved. {inboxCount} openings currently in your review inbox. {coverageGaps && 'See School results for incomplete checks.'}</small>}{paused && <small>Already submitted analyses may finish at OpenAI. Click Resume search to collect their results and continue with the remaining schools. Reopening this website keeps the queue paused; any coverage gaps remain in School results.</small>}{running && <small>{state?.configured ? 'Keep this website open to advance the search, with up to two schools running at once. Use Pause search to save your place for later.' : 'Add your API key to resume checking and import the results.'}</small>}</span>
      {(error || state?.job?.status === 'blocked') && <Button size="sm" variant="ghost" disabled={!state?.configured} onClick={() => request({ action: 'poll' }).catch(e => setError(e.message))}>Retry status</Button>}
      {state?.job?.status === 'blocked' && !job?.schools && <Button variant="ghost" size="sm" onClick={() => request({ action: 'stop_tracking' }).catch(e => setError(e.message))}>Stop tracking</Button>}
      {!running && !paused && coverageGaps && !!job?.schools?.length && <Button variant="outline" size="sm" disabled={busy || !state?.configured} onClick={() => retrySchools()}>Retry incomplete schools</Button>}
    </div>}
    {!!job?.schools?.length && <details className="rounded-md border p-3 text-sm" style={{ flexBasis: '100%', minWidth: 0 }}>
      <summary className="cursor-pointer font-medium">School results · {processedSchools}/{totalSchools} processed · {partialSchools} with gaps{failedSchools > 0 && ` · ${failedSchools} failed`}</summary>
      <div className="mt-3 grid max-h-[28rem] gap-3 overflow-y-auto">
        <p className="muted">{verifiedSchools}/{totalSchools} schools have complete coverage of all required sources. A coverage gap does not invalidate every opening found at that school. Across all attempts: {job.added || 0} new records and {job.updated || 0} updates; entries you tracked or archived are included in those totals.</p>
        {job.schools.map(school => <details key={school.schoolId} className="rounded-md border p-3">
          <summary className="cursor-pointer" style={{ overflowWrap: 'anywhere' }}><strong>{school.name}</strong> · {paused && school.status === 'running' ? 'Submitted · collect results on resume' : schoolStatus[school.status]}</summary>
          <div className="mt-2 grid gap-2">
            {school.summary && <p>{school.summary}</p>}
            {school.issues?.map((issue, index) => <p key={index} className="error-text">{issue}</p>)}
            {!!school.sources?.length ? <ul className="grid gap-2">
              {school.sources.map((source, index) => <li key={`${source.url}:${index}`} style={{ overflowWrap: 'anywhere' }}>
                <a className="text-blue-700 underline" href={source.url} target="_blank" rel="noreferrer">{source.url}</a>
                <span className="block text-xs">{!source.readable ? 'Not read' : !source.complete ? 'Partially read' : 'Read in full'}{source.error ? ` · ${source.error}` : ''}</span>
              </li>)}
            </ul> : <p className="muted">{school.status === 'pending' ? 'Waiting to check official hiring pages.' : school.status === 'running' ? 'Checking official hiring pages and linked postings.' : 'No source reading was recorded.'}</p>}
            {school.canRecover && <div><Button variant="outline" size="sm" disabled={busy || running || !state?.configured} onClick={async()=>{setBusy(true);try{await request({action:'recover_school',schoolId:school.schoolId});}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Recover saved result</Button><p className="muted">Retrieve the existing response without starting a new paid analysis.</p></div>}
            {['completed', 'partial', 'failed'].includes(school.status) && <div><Button variant="outline" size="sm" disabled={busy || running || paused || !state?.configured} onClick={() => retrySchools(school.schoolId)}>{school.status === 'completed' ? 'Search this school again' : 'Retry this school'}</Button></div>}
            {school.status === 'blocked' && <div><p className="muted">Restore the original key and retry status. If this result has expired, stop tracking it to allow a new attempt; this does not cancel work at OpenAI.</p><Button variant="outline" size="sm" disabled={busy} onClick={() => request({ action: 'stop_school_tracking', schoolId: school.schoolId }).catch(e => setError(e.message))}>Stop tracking this result</Button></div>}
          </div>
        </details>)}
      </div>
    </details>}
    {state?.links.filter(job => job.status !== 'completed' || job.needsRetry).map(linkStatus)}
    {recentLinks.length > 0 && <details className="link-analysis-history"><summary>Recent link analyses ({recentLinks.length})</summary>{recentLinks.map(linkStatus)}</details>}
    <Dialog open={open} onOpenChange={value => !busy && setOpen(value)}><DialogContent>
      <DialogTitle>{paused ? 'Search paused' : running ? 'Search in progress' : 'Search for faculty openings'}</DialogTitle>
      <DialogDescription>{RESEARCH_AREA_LABEL}. Check each school's official hiring pages and linked postings. New findings go to your review inbox; your notes and application progress are preserved.</DialogDescription>
      {!state ? <><p>{error || 'Checking search setup…'}</p><Button variant="outline" onClick={() => request().catch(e => setError(e.message))}>Check setup</Button></> : !state.configured ? <div className="search-setup"><h3>Add your API key</h3><p>Enter your OpenAI key and save it in this browser to enable AI analysis. Your saved search progress is retained.</p><Button onClick={() => { setOpen(false); onOpenKeySettings(); }}><KeyRound size={16}/> Enter API key</Button></div> : paused ? <><p>Your search is paused with {processedSchools}/{totalSchools} schools processed. Resume continues from saved progress.</p><Button disabled={busy} onClick={() => changePaused('resume')}><Play size={16}/> Resume search</Button></> : running ? <p>Research is already running. Return to the school list while it checks sources.</p> : <>
        <label className="field"><span>Schools to search</span><NativeSelect aria-label="Research school scope" value={scope} onChange={e => setScope(e.target.value)}><option value="considering">My shortlist ({considering} schools)</option><option value="all">Full discovery pool ({total} schools)</option>{schools.length > 0 && <option value="selected">Specific school</option>}</NativeSelect></label>
        {scope === 'selected' && <label className="field"><span>School</span><NativeSelect aria-label="School to research" value={selectedSchool} onChange={e => setSelectedSchool(e.target.value)}><option value="">Choose a school</option>{[...schools].sort((a, b) => a.name.localeCompare(b.name)).map(school => <option value={school.id} key={school.id}>{school.name}</option>)}</NativeSelect></label>}
        <p className="muted">Searches run only when you start them and use OpenAI API credits for each school. Larger searches proceed school by school, with up to two running at once. Keep this website open to advance the search; any gaps appear in the school results.</p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <Button onClick={start} disabled={busy || (scope === 'considering' && !considering) || (scope === 'all' && !total) || (scope === 'selected' && !selectedSchool)}>{busy ? 'Starting…' : <><Radar size={16}/> Start search</>}</Button>
      </>}
    </DialogContent></Dialog>
  </>;
}
