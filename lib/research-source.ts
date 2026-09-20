import { canonical } from './intake';

export type SourceReceipt = {
  requestId: string; url: string; retrievedUrl?: string; retrievedAt: string;
  method: 'interfolio' | 'html'; readable: boolean; complete: boolean;
  title?: string; institution?: string; postingId?: string; error?: string;
  openDate?: string; closingDate?: string; closingText?: string;
  status?: 'Open' | 'Closed';
};
export type SourceDocument = SourceReceipt & { text: string; datePassages: string[] };

export function interfolioId(url: string) {
  const u = new URL(canonical(url));
  return u.hostname === 'apply.interfolio.com' ? u.pathname.match(/^\/(\d+)\/?$/)?.[1] : undefined;
}

export function samePosting(a: string, b: string) {
  const id = interfolioId(a);
  return id ? id === interfolioId(b) : canonical(a) === canonical(b);
}

function allowed(url: string) {
  const u = new URL(canonical(url)), h = u.hostname;
  return h.endsWith('.edu') || h === 'utoronto.ca' || h.endsWith('.utoronto.ca') ||
    ['apply.interfolio.com', 'academicjobsonline.org', 'careercenter.cra.org'].includes(h) ||
    (h === 'logic.interfolio.com' && /^\/dossier-api\/positions\/\d+$/.test(u.pathname) && !u.search);
}

// No cookies or API credentials ever go to source sites. Check each redirect before fetching it.
async function page(url: string) {
  const signal = AbortSignal.timeout(15000);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (!allowed(url)) throw new Error('Direct reading is limited to supported academic websites.');
    const response = await fetch(url, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: 'text/html,application/json' } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error('The source returned an empty redirect.');
      url = canonical(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`The source returned HTTP ${response.status}.`);
    if (!/html|json/.test(response.headers.get('content-type') || '')) throw new Error('This source needs a document reader.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The source returned no content.');
    let size = 0, body = ''; const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1000000) { await reader.cancel(); throw new Error('Source exceeds the reading limit.'); }
      body += decoder.decode(value, { stream: true });
    }
    return { url, body: body + decoder.decode() };
  }
  throw new Error('The source redirected too many times.');
}

export function sourcePlainText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<(script|style|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li)>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|nbsp|quot|apos|lt|gt);/g, (_, n: string) => (({ amp: '&', nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[n] || ' '))
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' '; })
    .replace(/[^\S\n]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

// Keep the source's calendar date, never convert a midnight deadline through UTC.
export function calendarDate(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  const named = value.match(/^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(\d{4})$/i);
  if (!iso && !named) return undefined;
  const year = Number(iso?.[1] || named![3]);
  const month = iso ? Number(iso[2]) : ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(named![1].slice(0, 3).toLowerCase()) + 1;
  const day = Number(iso?.[3] || named![2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function parseInterfolio(data: any, url: string) {
  const id = interfolioId(url);
  if (!id || String(data?.position_id) !== id || !samePosting(url, String(data?.landing_page_url || 'https://apply.interfolio.com/'))) throw new Error('The portal returned a different posting.');
  if (data.private_flag === true) throw new Error('The posting is not public.');
  const title = sourcePlainText(data.position_name), institution = sourcePlainText(data.institution);
  const description = sourcePlainText(data.landing_page_description), instructions = sourcePlainText(data.application_instructions);
  if (!title || !institution || description.length + instructions.length < 100) throw new Error('The portal did not return the full posting.');
  const closingDate = calendarDate(data.end_date), openDate = calendarDate(data.start_date);
  // Interfolio's public landing-page template displays end_date with this time zone/time.
  const closingText = closingDate ? `Deadline: ${data.end_date} at 11:59 PM Eastern Time` : undefined;
  const text = [title, institution, `Location: ${sourcePlainText(data.location)}`, `Open Date: ${sourcePlainText(data.start_date)}`,
    closingText || `Deadline: ${sourcePlainText(data.end_date) || 'Not stated'}`, `Status: ${sourcePlainText(data.active_status)}`,
    'Description', description, 'Qualifications', sourcePlainText(data.qualifications), 'Application Instructions', instructions].join('\n');
  if (text.length > 70000) throw new Error('The posting exceeds the full-text reading limit.');
  return { title, institution, postingId: id, openDate, closingDate, closingText, text,
    status: data.active_status === 'Open' ? 'Open' as const : data.active_status === 'Closed' || data.is_closed === true ? 'Closed' as const : undefined };
}

export async function readResearchSource(request: { id: string; url: string }): Promise<SourceDocument> {
  const url = canonical(request.url), id = interfolioId(url);
  const base: SourceReceipt = { requestId: request.id, url, retrievedAt: new Date().toISOString(), method: id ? 'interfolio' : 'html', readable: false, complete: false };
  try {
    const retrieved = await page(id ? `https://logic.interfolio.com/dossier-api/positions/${id}` : url);
    if (id) {
      const posting = parseInterfolio(JSON.parse(retrieved.body), url);
      return { ...base, ...posting, retrievedUrl: retrieved.url, readable: true, complete: true, datePassages: datePassages(posting.text) };
    }
    // Preserve JSON-LD and date passages independently so metadata near the end is not lost.
    const structured = [...retrieved.body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]).join('\n');
    const fullText = sourcePlainText(retrieved.body) + (structured ? '\nStructured page data:\n' + structured : '');
    if (fullText.length < 200 || /enable javascript|checking your browser|just a moment/i.test(fullText.slice(0, 250))) throw new Error('The source returned a page shell instead of readable posting content.');
    return { ...base, retrievedUrl: retrieved.url, readable: true, complete: fullText.length <= 70000,
      title: sourcePlainText(retrieved.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]), text: fullText.slice(0, 70000), datePassages: datePassages(fullText) };
  } catch (error) {
    return { ...base, error: error instanceof Error && error.message.length < 150 ? error.message : 'The source could not be read.', text: '', datePassages: [] };
  }
}

function datePassages(text: string) {
  return [...text.matchAll(/.{0,180}(?:deadline|full consideration|early (?:round|review)|review.{0,30}begin|must be submitted|open date|validThrough).{0,600}/gi)].slice(0, 40).map(m => m[0]);
}

export function sourceReceipt({ text: _text, datePassages: _passages, ...receipt }: SourceDocument): SourceReceipt { return receipt; }
