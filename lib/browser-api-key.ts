'use client';

const storageKey = 'faculty-search-desk.openai-key';
export const keyChangedEvent = 'faculty-search-api-key-changed';

export function browserApiKey() {
  if (typeof window === 'undefined') return '';
  try { return window.localStorage.getItem(storageKey) || ''; }
  catch { return ''; }
}

export function saveBrowserApiKey(value: string) {
  const key = value.trim();
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key) || key.length > 1024) throw new Error('Enter a valid OpenAI API key beginning with sk-.');
  try { window.localStorage.setItem(storageKey, key); }
  catch { throw new Error('This browser blocked local storage. Allow storage for this website to save the key.'); }
  window.dispatchEvent(new Event(keyChangedEvent));
}

export function forgetBrowserApiKey() {
  try { window.localStorage.removeItem(storageKey); }
  catch { throw new Error('The browser could not remove the saved key. Clear this website’s storage in browser settings.'); }
  window.dispatchEvent(new Event(keyChangedEvent));
}

export function researchFetch(path: '/api/research' | '/api/desk', init: RequestInit = {}) {
  if (path !== '/api/research' && path !== '/api/desk') throw new Error('Invalid research endpoint.');
  const headers = new Headers(init.headers);
  const key = browserApiKey();
  if (key) {
    if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key) || key.length > 1024) throw new Error('Update the invalid saved key using API key.');
    headers.set('X-OpenAI-API-Key', key);
  }
  // Never forward a credential through redirects or put it in a URL/body.
  return fetch(path, { ...init, headers, cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
}
