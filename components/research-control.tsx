'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Radar, RefreshCw, AlertCircle, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

type State = { configured: boolean; job: null | { id: string; status: string; summary: string; error?: string; added?: number; gaps?: number; schoolCount: number } };
export function ResearchControl({ considering, total, queued, onComplete }: { considering: number; total: number; queued: number; onComplete: () => Promise<unknown> }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false), [scope, setScope] = useState('considering');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const completed = useRef('');
  const running = state?.job?.status === 'starting' || state?.job?.status === 'running';
  const request = useCallback(async (body?: unknown) => {
    const response = await fetch('/api/research', body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
    const result = await response.json() as State & { error?: string }; if (!response.ok) throw new Error(result.error || 'Search is temporarily unavailable.');
    setState(result); setError('');
    if (result.job?.status === 'completed' && completed.current !== result.job.id) { completed.current = result.job.id; await onComplete(); }
    return result as State;
  }, [onComplete]);
  useEffect(() => { request().catch(e => setError(e.message)); }, [request]);
  useEffect(() => {
    if (!running) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try { await request({ action: 'poll' }); } catch (e) { if (!stopped) setError((e as Error).message); }
      if (!stopped) timer = setTimeout(poll, 8000);
    }
    timer = setTimeout(poll, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, request]);
  async function start() {
    setBusy(true); setError('');
    try { await request({ action: 'start', scope }); setOpen(false); }
    catch (e) { setError((e as Error).message); await request().catch(() => {}); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <>
    <div className="research-control">
      <Button variant="outline" onClick={() => setOpen(true)}><Radar size={17}/>{running ? 'Search in progress' : 'Search now'}</Button>
      {state && !state.configured && <span className="search-meta">API setup needed</span>}
    </div>
    {(running || error || state?.job) && <div className={'search-progress' + (error || state?.job?.status === 'failed' ? ' has-error' : '')} role="status">
      {running ? <RefreshCw size={17} className="search-spinner"/> : state?.job?.status === 'completed' ? <Check size={17}/> : <AlertCircle size={17}/>}
      <span>{error || state?.job?.error || (running ? `Searching ${state?.job?.schoolCount} schools. Results will appear in your review inbox.` : state?.job?.status === 'completed' ? `Search complete. ${state.job.added || 0} new openings in your review inbox.${state.job.gaps ? ' Coverage gaps are listed in Research history.' : ''}` : state?.job?.summary)}{running && <small>You can leave and return. Results are saved when this website checks the completed search.</small>}</span>
      {error && <Button size="sm" variant="ghost" onClick={() => request(running ? { action: 'poll' } : undefined).catch(e => setError(e.message))}>Retry status</Button>}
    </div>}
    <Dialog open={open} onOpenChange={value => !busy && setOpen(value)}><DialogContent>
      <DialogTitle>{running ? 'Search in progress' : 'Search for faculty openings'}</DialogTitle>
      <DialogDescription>Check official hiring pages and discover new openings. New findings go to your review inbox; your notes and application progress are preserved.</DialogDescription>
      {!state ? <><p>{error || 'Checking search setup…'}</p><Button variant="outline" onClick={() => request().catch(e => setError(e.message))}>Check setup</Button></> : !state.configured ? <div className="search-setup"><h3>Connect an API key once</h3><p>This website has no OpenAI API key configured yet. No search has started.</p><p>Add <code>OPENAI_API_KEY</code> as a secret in this site’s hosting settings and apply it with a deployment. Keep the key out of chat and source code.</p><p className="muted">Search uses API billing. No daily schedule or separate Cloudflare account is needed.</p><a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Open OpenAI API keys ↗</a><Button variant="outline" onClick={() => request().catch(e => setError(e.message))}>Recheck connection</Button></div> : running ? <p>Research is already running. Return to the school list while it checks sources.</p> : <>
        <label className="field"><span>Schools to search</span><NativeSelect aria-label="Research school scope" value={scope} onChange={e => setScope(e.target.value)}><option value="considering">My shortlist ({considering} schools)</option><option value="all">Full discovery pool ({total} schools)</option></NativeSelect></label>
        <p className="muted">{queued ? `${queued} saved ${queued === 1 ? 'link is' : 'links are'} included first. ` : ''}Searches run only when you start them and use OpenAI API credits. Any incomplete coverage is recorded in Research history.</p>
        {error && <p role="alert" className="error-text">{error}</p>}
        <Button onClick={start} disabled={busy || (scope === 'considering' && !considering && !queued)}>{busy ? 'Starting…' : <><Radar size={16}/> Start search</>}</Button>
      </>}
    </DialogContent></Dialog>
  </>;
}
