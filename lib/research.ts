import { env } from 'cloudflare:workers';
import { database, getRecord, readDesk } from './store';
import { hash } from './intake';
import { decodeResearch, departmentName, matchesOpening, normalizedUrl, officialSource, openingPatch, providerSourceUrls, resultJsonSchema } from './research-result';
import type { Opening } from './types';
import { openAIResponse, ProviderError } from './openai-provider';
import { readResearchSource, sourceReceipt, samePosting, type SourceDocument, type SourceReceipt } from './research-source';
import { researchInstructions } from './research-prompt';

export type ResearchScope = 'considering' | 'all' | 'link';
type Job = { id: string; status: 'starting' | 'running' | 'blocked' | 'completed' | 'failed'; scope: ResearchScope; requestId?: string; sourceUrl?: string; startedAt: string; responseId?: string; browserKey?: boolean; schoolIds: string[]; requestIds: string[]; sources?: SourceReceipt[]; summary: string; error?: string; added?: number; updated?: number; checked?: number; gaps?: number; needsRetry?: boolean; revision?: number };
const key = (apiKey?: string) => apiKey?.trim() || (env.FACULTY_DESK_LOCAL_ONLY === '1' ? undefined : env.OPENAI_API_KEY?.trim());
const model = () => env.OPENAI_RESEARCH_MODEL?.trim() || 'gpt-5.6-terra';
const active = (job?: Job | null) => job?.status === 'starting' || job?.status === 'running' || job?.status === 'blocked';
const getJob = async (recordId = 'research'): Promise<Job | null> => getRecord('meta', recordId);
const recordId = (job: Job) => job.requestId ? 'research-link-' + job.requestId : 'research';
export const researchConfigured = (apiKey?: string) => !!key(apiKey);
async function linkJobs(): Promise<Job[]> {
  const rows = await database().prepare("SELECT data,revision FROM records WHERE kind='meta' AND id LIKE 'meta:research-link-%' ORDER BY updated_at DESC").all<{data: string; revision: number}>();
  return rows.results.map(r => ({ ...JSON.parse(r.data), revision: r.revision }));
}
const publicJob = (job: Job | null) => job && { id: job.id, status: job.status, scope: job.scope, requestId: job.requestId, requestIds: job.requestIds, sourceUrl: job.sourceUrl, startedAt: job.startedAt, schoolCount: job.schoolIds.length, summary: job.summary, error: job.error, added: job.added, updated: job.updated, checked: job.checked, gaps: job.gaps, needsRetry: job.needsRetry };

export async function researchStatus(apiKey?: string) {
  const job = await getJob();
  return { configured: !!key(apiKey), job: publicJob(job), links: (await linkJobs()).map(job => publicJob(job)!) };
}

async function provider(path: string, body?: unknown, apiKey?: string) {
  const credential = key(apiKey);
  if (!credential) throw new Error('Add your OpenAI API key using API key to enable research.');
  return openAIResponse(path, body, credential);
}

async function updateJob(job: Job, changes: Partial<Job>) {
  const next = { ...job, ...changes }; delete next.revision;
  await database().prepare('UPDATE records SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
    .bind(JSON.stringify(next), new Date().toISOString(), 'meta:' + recordId(job), job.revision).run();
}

export async function startResearch(scope: ResearchScope, requestId?: string, retry = false, apiKey?: string) {
  if (scope === 'link' && !requestId) throw new Error('Choose a saved link to analyze.');
  const jobRecordId = requestId ? 'research-link-' + requestId : 'research';
  if (!key(apiKey)) throw new Error('Add your OpenAI API key using API key. No search has started.');
  const broad = requestId ? await getJob() : null;
  if (active(broad) && broad!.requestIds.includes(requestId!)) return researchStatus(apiKey);
  const old = await getJob(jobRecordId);
  if (active(old) || (requestId && old && !retry)) return researchStatus(apiKey);
  const desk = await readDesk();
  const schools = desk.schools.filter(s => scope === 'all' || (scope === 'considering' && s.considering));
  const linksInProgress = (await linkJobs()).filter(active).flatMap(j => j.requestIds);
  const requests = desk.requests.filter(r => (r.status === 'Queued' || (requestId && retry)) && (requestId ? r.id === requestId : !linksInProgress.includes(r.id)));
  if (requestId && !requests.length) return researchStatus(apiKey);
  // Saved links can refer to schools outside the selected list.
  for (const r of requests) { const s = desk.schools.find(s => s.id === r.schoolId); if (s && !schools.some(x => x.id === s.id)) schools.push(s); }
  if (!schools.length && !requests.length) throw new Error('Select a school or save a link before searching.');
  const next: Job = { id: crypto.randomUUID(), status: 'starting', scope, browserKey: !!apiKey, ...(requestId ? { requestId, sourceUrl: requests[0].url } : {}), startedAt: new Date().toISOString(), schoolIds: schools.map(s => s.id), requestIds: requests.map(r => r.id), summary: 'Starting research…' };
  const db = database();
  const claim = await db.prepare(`INSERT INTO records(id,kind,data,revision,updated_at) VALUES(?,'meta',?,1,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=records.revision+1,updated_at=excluded.updated_at
    WHERE json_extract(records.data,'$.status') IN ('completed','failed')`).bind('meta:' + jobRecordId, JSON.stringify(next), next.startedAt).run();
  if (!claim.meta.changes) return researchStatus(apiKey);
  let job = (await getJob(jobRecordId))!;
  try {
    const sourceDocuments: SourceDocument[] = [];
    const preloadStarted = Date.now();
    for (let i = 0; i < requests.length && Date.now() - preloadStarted < 30000; i += 4) sourceDocuments.push(...await Promise.all(requests.slice(i, i + 4).map(readResearchSource)));
    // Leave time for provider startup inside the 120s lease; the web-search pass handles any remaining links.
    await updateJob(job, { sources: sourceDocuments.map(sourceReceipt) });
    job = (await getJob(jobRecordId))!;
    if (job.id !== next.id || job.status !== 'starting') return researchStatus(apiKey);
    const unreadablePortal = sourceDocuments.find(s => s.method === 'interfolio' && !s.readable);
    if (scope === 'link' && unreadablePortal) throw new Error(`Could not read the actual Interfolio posting: ${unreadablePortal.error} No AI request was started. Your link is saved; retry analysis when the source is available.`);
    const response = await provider('', {
      model: model(), background: true, store: true, reasoning: { effort: 'medium' },
      tools: [{ type: 'web_search' }], tool_choice: scope === 'link' && sourceDocuments.every(s => s.readable && s.complete) ? 'auto' : 'required', max_tool_calls: scope === 'link' ? 25 : 120,
      max_output_tokens: 16000, include: ['web_search_call.action.sources'],
      text: { format: { type: 'json_schema', name: 'faculty_research', strict: true, schema: resultJsonSchema } },
      instructions: researchInstructions(scope, new Date().toISOString().slice(0, 10)),
      input: JSON.stringify({ sourceDocuments, preferences: desk.settings.scope, directoryForQueuedLinks: requests.some(r => !r.schoolId) ? desk.schools.map(s => ({ id: s.id, name: s.name, domain: s.domain, departments: s.departments })) : [], schoolsToSearch: schools.map(s => ({ id: s.id, name: s.name, domain: s.domain, departments: s.departments, sources: s.sources.map(({ department, url }) => ({ department, url })) })), queuedLinks: requests.map(r => ({ id: r.id, url: r.url, schoolId: r.schoolId || null })), knownOpenings: desk.openings.filter(o => (schools.some(s => s.id === o.schoolId) || requests.some(r => [o.sourceUrl, o.applicationUrl].filter(Boolean).some(u => samePosting(r.url, u)))) && o.workflow !== 'Archived').map(o => ({ schoolId: o.schoolId, department: o.department, title: o.title, sourceUrl: o.sourceUrl, applicationUrl: o.applicationUrl })) }),
    }, apiKey);
    if (typeof response.id !== 'string' || !/^resp_[A-Za-z0-9_-]+$/.test(response.id)) throw new Error('The provider did not return a valid search ID. Check API usage before retrying.');
    await updateJob(job, { status: 'running', responseId: response.id, summary: 'Checking official sources…' });
  } catch (e) { await updateJob(job, { status: 'failed', error: (e as Error).message, summary: 'Search could not start.' }); throw e; }
  return researchStatus(apiKey);
}

export async function pollResearch(jobRecordId = 'research', apiKey?: string) {
  const job = await getJob(jobRecordId);
  if (!job || !active(job)) return researchStatus(apiKey);
  if (!job.responseId) {
    if (Date.now() - Date.parse(job.startedAt) > 120000) await updateJob(job, { status: 'failed', summary: 'Search start was interrupted.', error: 'The search start could not be confirmed. Check API usage before retrying.' });
    return researchStatus(apiKey);
  }
  if (job.browserKey && !apiKey) {
    await updateJob(job, { status: 'blocked', error: 'Enter the API key used to start this research, then retry status. The saved search will resume.' });
    return researchStatus(apiKey);
  }
  let response;
  try { response = await provider('/' + encodeURIComponent(job.responseId), undefined, apiKey); }
  catch (e) {
    if (e instanceof ProviderError && (job.browserKey || apiKey) && [401, 403, 404, 410].includes(e.status)) {
      await updateJob(job, { status: 'blocked', error: 'Could not access the saved result with this key. Restore the original key or one from the same OpenAI project and retry status. If the result expired, stop tracking it and start again.' });
      return researchStatus(apiKey);
    }
    if (!(e instanceof ProviderError) || ![404, 410].includes(e.status)) throw e;
    await updateJob(job, { status: 'failed', summary: 'Search result is no longer available.', error: 'The provider no longer has this result. No findings were imported. You can start a new search.' });
    return researchStatus(apiKey);
  }
  if (response.status === 'queued' || response.status === 'in_progress') {
    if (job.status === 'blocked') await updateJob(job, { status: 'running', error: undefined });
    return researchStatus(apiKey);
  }
  if (response.status !== 'completed') {
    await updateJob(job, { status: 'failed', summary: 'Search did not finish.', error: `Research ended with status ${['failed','cancelled','incomplete'].includes(response.status) ? response.status : 'unknown'}. No findings were imported. Try a smaller scope.` });
    return researchStatus(apiKey);
  }
  let result;
  try { result = decodeResearch(response); }
  catch (e) { await updateJob(job, { status: 'failed', summary: 'Search needs attention.', error: (e as Error).message }); return researchStatus(apiKey); }
  const desk = await readDesk();
  const evidence = providerSourceUrls(response);
  const directSources = (job.sources || []).filter(s => s.readable);
  for (const source of directSources) {
    evidence.add(normalizedUrl(source.url));
    if (source.method === 'html' && source.retrievedUrl) evidence.add(normalizedUrl(source.retrievedUrl));
  }
  const inspected = [...new Set([...result.inspectedUrls, ...directSources.map(s => s.url)].map(normalizedUrl))].filter(u => evidence.has(u));
  const gaps = [...result.gaps];
  for (const source of directSources) if (!source.complete) gaps.push(`${source.url}: direct source text was truncated; complete analysis is not confirmed.`);
  if (result.inspectedUrls.some(u => !evidence.has(normalizedUrl(u)))) gaps.push('Some reported source URLs were not present in the provider’s search evidence and were excluded.');
  const checkedIds = new Set(result.checkedSchoolIds.filter(id => job.schoolIds.includes(id)));
  for (const id of job.schoolIds) if (!checkedIds.has(id)) gaps.push(`${desk.schools.find(s => s.id === id)?.name || id}: coverage not confirmed.`);
  const date = new Date().toISOString();
  const db = database();
  // Every write, including the completion marker, shares one atomic batch and the same job revision guard.
  const guard = "EXISTS(SELECT 1 FROM records WHERE id=? AND revision=?)";
  const statements: D1PreparedStatement[] = [];
  const write = (kind: string, id: string, data: unknown, patch: unknown = data) => statements.push(db.prepare(`INSERT INTO records(id,kind,data,revision,updated_at) SELECT ?,?,?,1,? WHERE ${guard}
    ON CONFLICT(id) DO UPDATE SET data=json_patch(records.data,?),revision=records.revision+1,updated_at=excluded.updated_at`).bind(kind + ':' + id, kind, JSON.stringify(data), date, 'meta:' + recordId(job), job.revision, JSON.stringify(patch)));
  let added = 0, updated = 0;
  const completedIds = new Set<string>();
  const importedRequests = new Map<string, string>();
  const excludedRequests = new Set<string>();
  for (const item of result.openings) {
    const queuedSource = desk.requests.find(r => r.id === item.sourceRequestId && job.requestIds.includes(r.id) && inspected.includes(normalizedUrl(r.url)));
    const source = (job.sources || []).find(s => s.requestId === (queuedSource?.id || job.requestId));
    if (source?.method === 'interfolio' && (!source.readable || !source.complete ||
      !samePosting(source.url, item.sourceUrl) || (item.applicationUrl && !samePosting(source.url, item.applicationUrl)))) {
      gaps.push(`${item.title}: not imported because it does not establish the exact requested posting.`);
      excludedRequests.add(source.requestId);
      continue;
    }
    const school = desk.schools.find(s => s.id === item.schoolId && (job.schoolIds.includes(s.id) || queuedSource));
    if (!school || !inspected.includes(normalizedUrl(item.sourceUrl)) || !officialSource(item.sourceUrl, school)) { gaps.push(`${item.title}: not imported because its school or official source evidence could not be confirmed.`); if (queuedSource) excludedRequests.add(queuedSource.id); continue; }
    const found = { ...item, department: departmentName(item.department, school) };
    if (source?.method === 'interfolio' && source.readable) {
      found.title = source.title!;
      found.sourceUrl = source.url;
      found.applicationUrl = source.url;
      if (source.status) found.hiringStatus = source.status;
      // A parsed date from this exact public posting cannot be dropped by model output.
      if (source.closingDate) {
        const priorClosing = found.hardDeadline;
        found.hardDeadline = source.closingDate;
        const reviewDate = /review|consideration|priority/i.test(found.deadlineType || '');
        if (!found.deadline || found.deadline >= source.closingDate || (!reviewDate && (found.deadline === priorClosing || /deadline|unknown/i.test(found.deadlineType || 'Unknown')))) {
          found.deadline = source.closingDate;
          found.deadlineType = 'Application deadline';
        }
        found.deadlineText = [source.closingText, found.deadlineText].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
      }
    }
    if (found.applicationUrl && (!evidence.has(normalizedUrl(found.applicationUrl)) || !officialSource(found.applicationUrl, school))) {
      gaps.push(`${item.title}: the application URL was omitted because its source evidence could not be confirmed.`);
      found.applicationUrl = null;
    }
    const old = desk.openings.find(o => matchesOpening(o, found));
    const id = old?.id || await hash(found.schoolId + '|' + found.department.toLowerCase() + '|' + normalizedUrl(found.applicationUrl || found.sourceUrl) + (found.applicationUrl ? '' : '|' + found.title.trim().toLowerCase()));
    const patch = openingPatch(found, date.slice(0, 10));
    const record = { id, applicationUrl: '', deadline: '', deadlineType: 'Unknown', deadlineText: '', hardDeadline: '', rank: 'Unknown', areas: '', materials: '', letters: '', hiringStatus: 'Unverified', workflow: 'Inbox', notes: '', ...patch } as Opening;
    write('opening', id, record, patch);
    if (queuedSource) importedRequests.set(queuedSource.id, school.id);
    if (old) updated++; else added++;
    const i = desk.openings.findIndex(o => o.id === id); if (i >= 0) desk.openings[i] = { ...desk.openings[i], ...patch } as Opening; else desk.openings.push(record);
  }
  for (const id of result.completedRequestIds) {
    const request = desk.requests.find(r => r.id === id && job.requestIds.includes(id));
    if (!request || !inspected.includes(normalizedUrl(request.url))) continue;
    const source = (job.sources || []).find(s => s.requestId === id);
    if (excludedRequests.has(id) || (source?.readable && !source.complete) || (source?.method === 'interfolio' && (!source.readable || !source.complete))) continue;
    completedIds.add(id);
    const requestPatch = { status: 'Researched', error: '', ...(source?.title ? { title: source.title } : {}), ...(importedRequests.has(id) ? { schoolId: importedRequests.get(id) } : {}) };
    write('request', id, { ...request, ...requestPatch }, requestPatch);
    const draftId = 'opening:intake-' + id;
    statements.push(db.prepare(`UPDATE records SET data=json_set(data,'$.workflow','Archived','$.summary','Research completed. See the research history and opening records.'),revision=revision+1,updated_at=? WHERE id=? AND json_extract(data,'$.workflow')='Inbox' AND json_extract(data,'$.verification') LIKE 'Draft%' AND ${guard}`).bind(date, draftId, 'meta:' + recordId(job), job.revision));
  }
  for (const id of job.requestIds) if (!completedIds.has(id)) gaps.push(`Saved link still awaiting verification: ${desk.requests.find(r => r.id === id)?.url || id}`);
  const coverage = job.scope === 'link' ? `${completedIds.size}/${job.requestIds.length} links analyzed.` : `${checkedIds.size}/${job.schoolIds.length} schools reported checked.`;
  const summary = `${added} new, ${updated} updated openings. ${coverage} ${result.summary}`;
  write('run', job.id, { id: job.id, date, summary, checked: inspected.length, newOpenings: added, failures: gaps, sources: inspected });
  const done = { ...job, status: 'completed', error: undefined, summary, added, updated, checked: inspected.length, gaps: gaps.length, needsRetry: job.requestIds.some(id => !completedIds.has(id)) }; delete done.revision;
  statements.push(db.prepare('UPDATE records SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').bind(JSON.stringify(done), date, 'meta:' + recordId(job), job.revision));
  await db.batch(statements);
  return researchStatus(apiKey);
}

export async function pollAllResearch(apiKey?: string) {
  const jobs = ['research', ...(await linkJobs()).filter(active).map(recordId)];
  const results = await Promise.allSettled(jobs.map(id => pollResearch(id, apiKey)));
  const errors = results.flatMap(r => r.status === 'rejected' ? [(r.reason as Error).message] : []);
  return { ...await researchStatus(apiKey), errors };
}

export async function stopTrackingResearch(requestId?: string, apiKey?: string) {
  const job = await getJob(requestId ? 'research-link-' + requestId : 'research');
  if (job?.status === 'blocked') await updateJob(job, { status: 'failed', summary: 'Stopped tracking this result.', error: 'You can now start again. Research already running at OpenAI was not canceled.' });
  return researchStatus(apiKey);
}
