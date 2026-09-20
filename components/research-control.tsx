'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar, RefreshCw, AlertCircle, Check, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { browserApiKey, keyChangedEvent, researchFetch } from '@/lib/browser-api-key';

type Job = { id: string; status: string; summary: string; error?: string; added?: number; updated?: number; gaps?: number; needsRetry?: boolean; schoolCount: number; requestId?: string; sourceUrl?: string };
type State = { configured: boolean; job: Job | null; links: Job[]; errors?: string[] };
export function ResearchControl({ considering, total, queued, revision, onConfigured, onComplete, onOpenKeySettings }: { considering: number; total: number; queued: number; revision: number; onConfigured: (value: boolean) => void; onComplete: () => Promise<unknown>; onOpenKeySettings: () => void }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false), [scope, setScope] = useState('considering');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const completed = useRef(new Set<string>());
  const credentialVersion = useRef(0);
  const running = state?.job?.status === 'starting' || state?.job?.status === 'running';
  const linkRunning = state?.links.some(j => ['starting', 'running'].includes(j.status));
  const request = useCallback(async (body?: unknown) => {
    const version = credentialVersion.current;
    const response = await researchFetch('/api/research', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const result = await response.json() as State & { error?: string }; if (!response.ok) throw new Error(result.error || 'Search is temporarily unavailable.');
    if (version !== credentialVersion.current) return result;
    setState(result); setError(result.errors?.join(' ') || ''); onConfigured(result.configured);
    const finished = [result.job, ...result.links].filter((j): j is Job => !!j && j.status === 'completed' && !completed.current.has(j.id));
    if (finished.length) { await onComplete(); finished.forEach(j => completed.current.add(j.id)); }
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
    try { await request({ action: 'start', scope }); setOpen(false); }
    catch (e) { setError((e as Error).message); await request().catch(() => {}); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <div className="research-control">
      <Button variant="outline" onClick={() => setOpen(true)}><Radar size={17}/>{running ? 'Search in progress' : 'Search now'}</Button>
      <Button variant="ghost" onClick={onOpenKeySettings}><KeyRound size={16}/> API key</Button>
      {state && !state.configured && <span className="search-meta">API setup needed</span>}
    </div>
    {state?.links.filter((job, index) => job.status !== 'completed' || index < 3).map(job => <div key={job.id} className={'search-progress' + (job.status === 'failed' ? ' has-error' : '')} role="status">
      {['starting', 'running'].includes(job.status) ? <RefreshCw size={17} className="search-spinner"/> : job.status === 'completed' ? <Check size={17}/> : <AlertCircle size={17}/>}
      <span><a href={job.sourceUrl} target="_blank" rel="noreferrer">{job.sourceUrl && new URL(job.sourceUrl).hostname}</a>: {job.error || (job.status === 'completed' ? `Analysis complete. ${job.added || 0} new, ${job.updated || 0} updated openings.${job.gaps ? ' Review coverage issues in Research history.' : ' Ready in your review inbox.'}` : 'AI is reading the page and its application links…')}</span>
      {(job.status === 'failed' || (job.status === 'completed' && job.needsRetry)) && <Button variant="ghost" size="sm" disabled={busy || !state.configured} onClick={async () => { setBusy(true); try { await request({ action: 'analyze', requestId: job.requestId }); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>Retry analysis</Button>}
      {job.status === 'blocked' && <><Button variant="ghost" size="sm" disabled={!state.configured} onClick={() => request({ action: 'poll' }).catch(e => setError(e.message))}>Retry status</Button><Button variant="ghost" size="sm" onClick={() => request({ action: 'stop_tracking', requestId: job.requestId }).catch(e => setError(e.message))}>Stop tracking</Button></>}
    </div>)}
    {(running || error || state?.job) && <div className={'search-progress' + (error || state?.job?.status === 'failed' ? ' has-error' : '')} role="status">
      {running ? <RefreshCw size={17} className="search-spinner"/> : state?.job?.status === 'completed' ? <Check size={17}/> : <AlertCircle size={17}/>}
      <span>{error || state?.job?.error || (running ? `Searching ${state?.job?.schoolCount} schools. Results will appear in your review inbox.` : state?.job?.status === 'completed' ? `Search complete. ${state.job.added || 0} new openings in your review inbox.${state.job.gaps ? ' Coverage gaps are listed in Research history.' : ''}` : state?.job?.summary)}{running && <small>{state?.configured?'You can leave and return. Results are saved when this website checks the completed search.':'Add your API key to resume checking and import the results.'}</small>}</span>
      {(error || state?.job?.status === 'blocked') && <Button size="sm" variant="ghost" disabled={!state?.configured} onClick={() => request({ action: 'poll' }).catch(e => setError(e.message))}>Retry status</Button>}
      {state?.job?.status === 'blocked' && <Button variant="ghost" size="sm" onClick={() => request({ action: 'stop_tracking' }).catch(e => setError(e.message))}>Stop tracking</Button>}
    </div>}
    <Dialog open={open} onOpenChange={value => !busy && setOpen(value)}><DialogContent>
      <DialogTitle>{running ? 'Search in progress' : 'Search for faculty openings'}</DialogTitle>
      <DialogDescription>Check official hiring pages and discover new openings. New findings go to your review inbox; your notes and application progress are preserved.</DialogDescription>
      {!state ? <><p>{error || 'Checking search setup…'}</p><Button variant="outline" onClick={() => request().catch(e => setError(e.message))}>Check setup</Button></> : !state.configured ? <div className="search-setup"><h3>Add your API key</h3><p>Enter your OpenAI key and save it in this browser to enable AI analysis. No search has started.</p><Button onClick={() => { setOpen(false); onOpenKeySettings(); }}><KeyRound size={16}/> Enter API key</Button></div> : running ? <p>Research is already running. Return to the school list while it checks sources.</p> : <>
        <label className="field"><span>Schools to search</span><NativeSelect aria-label="Research school scope" value={scope} onChange={e => setScope(e.target.value)}><option value="considering">My shortlist ({considering} schools)</option><option value="all">Full discovery pool ({total} schools)</option></NativeSelect></label>
        <p className="muted">{queued ? `${queued} saved ${queued === 1 ? 'link is' : 'links are'} included first. ` : ''}Searches run only when you start them and use OpenAI API credits. Any incomplete coverage is recorded in Research history.</p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <Button onClick={start} disabled={busy || (scope === 'considering' && !considering && !queued)}>{busy ? 'Starting…' : <><Radar size={16}/> Start search</>}</Button>
      </>}
    </DialogContent></Dialog>
  </>;
}
