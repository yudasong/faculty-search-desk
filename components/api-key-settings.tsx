'use client';

import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { browserApiKey, forgetBrowserApiKey, keyChangedEvent, saveBrowserApiKey } from '@/lib/browser-api-key';

export function ApiKeySettings({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
  const [saved, setSaved] = useState(false), [value, setValue] = useState(''), [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const sync = () => { setSaved(!!browserApiKey()); setNotice(''); };
    sync(); window.addEventListener(keyChangedEvent, sync); window.addEventListener('storage', sync);
    return () => { window.removeEventListener(keyChangedEvent, sync); window.removeEventListener('storage', sync); };
  }, []);
  useEffect(() => { if (!open) { setValue(''); setError(''); } }, [open]);
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="api-key-dialog">
    <DialogTitle><KeyRound size={19} className="inline-key-icon"/> OpenAI API key</DialogTitle>
    <DialogDescription>Save your key in this browser to enable link analysis and Search now.</DialogDescription>
    <p>The key is saved in this browser’s local storage on this device. For AI requests, it passes through this website’s server to OpenAI over HTTPS. When running locally, that server is on your computer. The website does not save the key in its database.</p>
    <form onSubmit={e => {
      e.preventDefault(); setError('');
      try { saveBrowserApiKey(value); setValue(''); setNotice('Key saved in this browser. It will be checked when you use AI analysis.'); }
      catch (e) { setError((e as Error).message); }
    }}>
      <label className="field"><span>{saved ? 'Replace saved key' : 'Your API key'}</span><Input type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="sk-…" value={value} onChange={e => setValue(e.target.value)} required maxLength={1024}/></label>
      <p className="muted small-copy">Use a personal browser profile. Anyone with access to its stored data could retrieve the key. Re-enter the same key to resume a search on another device.</p>
      {error && <p role="alert" className="error-text">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {saved && !notice && <p role="status">A key is saved in this browser.</p>}
      <div className="dialog-actions">
        {saved && <Button type="button" variant="outline" onClick={() => { try { forgetBrowserApiKey(); setValue(''); setError(''); setNotice('Key removed from this browser. This does not revoke the key at OpenAI or cancel research already started.'); } catch (e) { setError((e as Error).message); } }}>Forget key</Button>}
        <Button type="submit" disabled={!value.trim()}>{saved ? 'Replace key' : 'Save key locally'}</Button>
      </div>
    </form>
    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">Create or manage OpenAI API keys ↗</a>
    <p className="muted small-copy">API usage is billed to the OpenAI project that owns your key.</p>
  </DialogContent></Dialog>;
}
