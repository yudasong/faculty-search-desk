import { env } from 'cloudflare:workers';
import { database, getRecord, readDesk } from './store';
import { hash } from './intake';
import { decodeResearch, departmentName, matchesArchivedOpening, matchesOpening, normalizedUrl, officialSource, openingIdentityKey, openingPatch, providerSourceUrls, resultJsonSchema, userArchived } from './research-result';
import type { Opening } from './types';
import { openAIResponse, ProviderError } from './openai-provider';
import { readResearchSource, sourceReceipt, samePosting, individualPosting, postingPage, type SourceDocument, type SourceReceipt } from './research-source';
import { DEFAULT_RESEARCH_SCOPE, discoveryExclusionReason, scopeEvidenceIssue, staleOpeningReason } from './research-scope';
import { researchInstructions } from './research-prompt';
import { institutionMatches, schoolFromPosting } from './research-school';
import { discoverSchoolSources } from './research-discovery';
import { assessSchoolCoverage, importedPostingAliases, type DepartmentCheck } from './research-coverage';

export type ResearchScope = 'considering' | 'all' | 'link' | 'school';
export type Job = { id: string; status: 'starting' | 'running' | 'blocked' | 'completed' | 'failed'; scope: ResearchScope; requestId?: string; sourceUrl?: string; startedAt: string; responseId?: string; browserKey?: boolean; schoolIds: string[]; requestIds: string[]; sources?: SourceReceipt[]; summary: string; error?: string; added?: number; updated?: number; checked?: number; gaps?: number; needsRetry?: boolean; revision?: number;
  scopePolicyVersion?: number; recordKey?: string; documents?: SourceDocument[]; departments?: DepartmentCheck[]; sourceIssues?: string[]; verificationPass?: boolean; coverageIssues?: string[]; uncertainStart?: boolean; dispatchBlocked?: boolean; sourceReviews?: ReturnType<typeof decodeResearch>['sourceReviews']; importedUrls?: string[] };
const key = (apiKey?: string) => apiKey?.trim() || (env.FACULTY_DESK_LOCAL_ONLY === '1' ? undefined : env.OPENAI_API_KEY?.trim());
const model = () => env.OPENAI_RESEARCH_MODEL?.trim() || 'gpt-5.6-terra';
const active = (job?: Job | null) => job?.status === 'starting' || job?.status === 'running' || job?.status === 'blocked';
export const getJob = async (recordId = 'research'): Promise<Job | null> => getRecord('meta', recordId);
const recordId = (job: Job) => job.recordKey || (job.requestId ? 'research-link-' + job.requestId : 'research');
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
  const result = await database().prepare('UPDATE records SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
    .bind(JSON.stringify(next), new Date().toISOString(), 'meta:' + recordId(job), job.revision).run();
  return !!result.meta.changes;
}

export async function startSchoolResearch(schoolId: string, recordKey: string, apiKey?: string) {
  return startResearch('school', undefined, false, apiKey, { schoolId, recordKey });
}

export async function startResearch(scope: ResearchScope, requestId?: string, retry = false, apiKey?: string, schoolTask?: { schoolId: string; recordKey: string }) {
  if (scope === 'link' && !requestId) throw new Error('Choose a saved link to analyze.');
  const jobRecordId = schoolTask?.recordKey || (requestId ? 'research-link-' + requestId : 'research');
  if (!key(apiKey)) throw new Error('Add your OpenAI API key using API key. No search has started.');
  const broad = requestId ? await getJob() : null;
  if (active(broad) && broad!.requestIds.includes(requestId!)) return researchStatus(apiKey);
  const old = await getJob(jobRecordId);
  if (active(old) || ((requestId || schoolTask) && old && !retry)) return researchStatus(apiKey);
  const desk = await readDesk();
  const schools = desk.schools.filter(s => schoolTask ? s.id === schoolTask.schoolId : scope === 'all' || (scope === 'considering' && s.considering));
  const linksInProgress = (await linkJobs()).filter(active).flatMap(j => j.requestIds);
  const requests = schoolTask ? [] : desk.requests.filter(r => (r.status === 'Queued' || (requestId && retry)) && (requestId ? r.id === requestId : !linksInProgress.includes(r.id)));
  if (requestId && !requests.length) return researchStatus(apiKey);
  // Saved links can refer to schools outside the selected list.
  for (const r of requests) { const s = desk.schools.find(s => s.id === r.schoolId); if (s && !schools.some(x => x.id === s.id)) schools.push(s); }
  if (!schools.length && !requests.length) throw new Error('Select a school or save a link before searching.');
  const next: Job = { id: crypto.randomUUID(), status: 'starting', scope, browserKey: !!apiKey, ...(schoolTask ? { recordKey: schoolTask.recordKey, scopePolicyVersion: 2 } : {}), ...(requestId ? { requestId, sourceUrl: requests[0].url } : {}), startedAt: new Date().toISOString(), schoolIds: schools.map(s => s.id), requestIds: requests.map(r => r.id), summary: 'Starting research…' };
  const db = database();
  const claim = await db.prepare(`INSERT INTO records(id,kind,data,revision,updated_at) VALUES(?,'meta',?,1,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=records.revision+1,updated_at=excluded.updated_at
    WHERE json_extract(records.data,'$.status') IN ('completed','failed')`).bind('meta:' + jobRecordId, JSON.stringify(next), next.startedAt).run();
  if (!claim.meta.changes) return researchStatus(apiKey);
  let job = (await getJob(jobRecordId))!;
  try {
    const discovery = schoolTask ? await discoverSchoolSources(schools[0], desk.openings) : undefined;
    const sourceDocuments: SourceDocument[] = discovery?.documents || [];
    const preloadStarted = Date.now();
    for (let i = 0; i < requests.length && Date.now() - preloadStarted < 30000; i += 4) sourceDocuments.push(...await Promise.all(requests.slice(i, i + 4).map(readResearchSource)));
    // Leave time for provider startup inside the 120s lease; the web-search pass handles any remaining links.
    const sourceIssues = discovery?.issues || [];
    // Keep persisted public source text bounded; truncation remains an explicit coverage gap.
    let remaining = 180000;
    for (const document of sourceDocuments) {
      if (document.text.length > remaining) { document.text = document.text.slice(0, remaining); document.complete = false; sourceIssues.push(`${document.url}: analysis text budget exceeded.`); }
      remaining -= document.text.length;
    }
    await updateJob(job, { sources: sourceDocuments.map(sourceReceipt), ...(schoolTask ? { documents: sourceDocuments, departments: discovery!.departments, sourceIssues } : {}) });
    job = (await getJob(jobRecordId))!;
    if (job.id !== next.id || job.status !== 'starting') return researchStatus(apiKey);
    const unreadablePortal = sourceDocuments.find(s => individualPosting(s.url) && !s.readable);
    if (scope === 'link' && unreadablePortal) throw new Error(`Could not read the actual posting: ${unreadablePortal.error} No AI request was started. Your link is saved; retry analysis when the source is available.`);
    const response = await provider('', {
      model: model(), background: true, store: true, reasoning: { effort: 'medium' },
      tools: [{ type: 'web_search' }], tool_choice: scope === 'link' && sourceDocuments.every(s => s.readable && s.complete) ? 'auto' : 'required', max_tool_calls: scope === 'school' ? 12 : scope === 'link' ? 25 : 120,
      max_output_tokens: 16000, include: ['web_search_call.action.sources'],
      text: { format: { type: 'json_schema', name: 'faculty_research', strict: true, schema: resultJsonSchema } },
      instructions: researchInstructions(scope, new Date().toISOString().slice(0, 10)),
      input: JSON.stringify({ sourceDocuments, preferences: DEFAULT_RESEARCH_SCOPE, directoryForQueuedLinks: requests.some(r => !r.schoolId) ? desk.schools.map(s => ({ id: s.id, name: s.name, domain: s.domain, departments: s.departments })) : [], schoolsToSearch: schools.map(s => ({ id: s.id, name: s.name, domain: s.domain, departments: s.departments, sources: s.sources.map(({ department, url }) => ({ department, url })) })), queuedLinks: requests.map(r => ({ id: r.id, url: r.url, schoolId: r.schoolId || null })), knownOpenings: desk.openings.filter(o => (schools.some(s => s.id === o.schoolId) || requests.some(r => [o.sourceUrl, o.applicationUrl].filter(Boolean).some(u => samePosting(r.url, u)))) && o.workflow !== 'Archived').map(o => ({ schoolId: o.schoolId, department: o.department, title: o.title, sourceUrl: o.sourceUrl, applicationUrl: o.applicationUrl })) }),
    }, apiKey);
    if (typeof response.id !== 'string' || !/^resp_[A-Za-z0-9_-]+$/.test(response.id)) throw new Error('The provider did not return a valid search ID. Check API usage before retrying.');
    await updateJob(job, { status: 'running', responseId: response.id, summary: 'Checking official sources…' });
  } catch (e) { await updateJob(job, { status: 'failed', error: (e as Error).message, dispatchBlocked: e instanceof ProviderError, uncertainStart: /may have reached|Check API usage|search ID|unreadable response/i.test((e as Error).message), summary: 'Search could not start.' }); throw e; }
  return researchStatus(apiKey);
}

export async function pollResearch(jobRecordId = 'research', apiKey?: string, recoverSaved = false) {
  let job = await getJob(jobRecordId);
  if (!job || (recoverSaved ? job.status !== 'failed' || !job.responseId : !active(job))) return researchStatus(apiKey);
  if (!job.responseId) {
    if (Date.now() - Date.parse(job.startedAt) > 120000) await updateJob(job, { status: 'failed', uncertainStart: true, summary: 'Search start was interrupted.', error: 'The search start could not be confirmed. Check API usage before retrying.' });
    return researchStatus(apiKey);
  }
  if (job.browserKey && !apiKey) {
    await updateJob(job, { status: recoverSaved ? 'failed' : 'blocked', error: recoverSaved ? 'Enter the original API key, then choose Recover saved result again.' : 'Enter the API key used to start this research, then retry status. The saved search will resume.' });
    return researchStatus(apiKey);
  }
  let response;
  try { response = await provider('/' + encodeURIComponent(job.responseId), undefined, apiKey); }
  catch (e) {
    if (e instanceof ProviderError && (job.browserKey || apiKey) && [401, 403, 404, 410].includes(e.status)) {
      await updateJob(job, { status: recoverSaved ? 'failed' : 'blocked', error: recoverSaved ? 'Could not retrieve the saved result. Use the original key or one from the same OpenAI project, then choose Recover saved result again. An expired result requires a new search.' : 'Could not access the saved result with this key. Restore the original key or one from the same OpenAI project and retry status. If the result expired, stop tracking it and start again.' });
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
  if (recoverSaved && job.scope === 'school') {
    const school = desk.schools.find(s => s.id === job!.schoolIds[0]);
    const existing = new Set((job.sources || []).flatMap(s => [s.url, s.retrievedUrl].filter(Boolean).map(u => normalizedUrl(u!))));
    const candidates = [...new Set(result.openings.map(o => normalizedUrl(o.sourceUrl)))].filter(url => !existing.has(url) && school && officialSource(url, school));
    const documents = [...(job.documents || [])], sourceIssues = [...(job.sourceIssues || [])];
    for (let i = 0; i < Math.min(candidates.length, 8); i += 4) documents.push(...await Promise.all(candidates.slice(i, Math.min(i + 4, 8)).map((url, n) => readResearchSource({ id: `recover:${school!.id}:${i + n}`, url }))));
    for (const url of candidates.slice(8)) sourceIssues.push(`${url}: saved-result recovery source limit reached.`);
    if (candidates.length) {
      let remaining = 180000;
      for (const doc of documents) { if (doc.text.length > remaining) { doc.text = doc.text.slice(0, remaining); doc.complete = false; } remaining -= doc.text.length; }
      if (!await updateJob(job, { documents, sources: documents.map(sourceReceipt), sourceIssues })) return researchStatus(apiKey);
      job = (await getJob(jobRecordId))!;
    }
  }
  // A saved-response recovery is GET-only: it may read public sources and import them,
  // but must never launch a second extraction request or restart discovery.
  if (job.scope === 'school' && !job.verificationPass && !recoverSaved) {
    const school = desk.schools.find(s => s.id === job!.schoolIds[0])!;
    const existing = new Set((job.sources || []).flatMap(s => [s.url, s.retrievedUrl].filter(Boolean).map(u => normalizedUrl(u!))));
    const candidates = [...new Set([...result.openings.map(o => o.sourceUrl), ...result.sourceReviews.flatMap(r => [r.url, ...r.openingUrls])].map(normalizedUrl))];
    const missing = candidates.filter(url => !existing.has(url));
    if (missing.length) {
      // Claim the verification phase BEFORE any additional provider request. Competing polls
      // cannot spend twice; an interrupted phase stays visible for an explicit retry.
      if (!await updateJob(job, { status: 'starting', responseId: undefined, verificationPass: true, startedAt: new Date().toISOString(), summary: 'Reading discovered postings…' })) return researchStatus(apiKey);
      job = (await getJob(jobRecordId))!;
      const ownedId = job.id, sourceIssues = [...(job.sourceIssues || [])];
      const allowed = missing.filter(url => officialSource(url, school));
      for (const url of missing.filter(url => !allowed.includes(url))) sourceIssues.push(`${url}: discovered URL is outside this school's official sources.`);
      for (const url of allowed.slice(8)) sourceIssues.push(`${url}: discovered source exceeded this attempt's verification limit.`);
      const documents = [...(job.documents || [])];
      for (let i = 0; i < Math.min(allowed.length, 8); i += 4) documents.push(...await Promise.all(allowed.slice(i, Math.min(i + 4, 8)).map((url, n) => readResearchSource({ id: `verify:${school.id}:${i + n}`, url }))));
      let remaining = 180000;
      for (const doc of documents) {
        if (doc.text.length > remaining) { doc.text = doc.text.slice(0, remaining); doc.complete = false; sourceIssues.push(`${doc.url}: analysis text budget exceeded.`); }
        remaining -= doc.text.length;
      }
      if (!await updateJob(job, { documents, sources: documents.map(sourceReceipt), sourceIssues })) return researchStatus(apiKey);
      job = (await getJob(jobRecordId))!;
      if (job.id !== ownedId || job.status !== 'starting') return researchStatus(apiKey);
      try {
        const next = await provider('', {
          model: model(), background: true, store: true, reasoning: { effort: 'medium' }, max_output_tokens: 16000,
          text: { format: { type: 'json_schema', name: 'faculty_research', strict: true, schema: resultJsonSchema } },
          instructions: researchInstructions('school', new Date().toISOString().slice(0, 10)) + '\nThis is the final extraction pass. The website fetched the newly discovered URLs. Use only the supplied documents for factual extraction. For each candidate, import its verified opening or explicitly explain why it is irrelevant/blocked. Do not lose candidate URLs or label unreadable documents as checked. Preserve sourceReviews for every source.',
          input: JSON.stringify({ sourceDocuments: documents, preferences: DEFAULT_RESEARCH_SCOPE, schoolsToSearch: [{ id: school.id, name: school.name, domain: school.domain, departments: school.departments }], discoveryResult: result }),
        }, apiKey);
        if (typeof next.id !== 'string' || !/^resp_[A-Za-z0-9_-]+$/.test(next.id)) throw new Error('The provider did not return a valid search ID. Check API usage before retrying.');
        await updateJob(job, { responseId: next.id, status: 'running', summary: 'Extracting verified posting details…' });
      } catch (e) { await updateJob(job, { status: 'failed', error: (e as Error).message, dispatchBlocked: e instanceof ProviderError, uncertainStart: /may have reached|Check API usage|search ID|unreadable response/i.test((e as Error).message) }); }
      return researchStatus(apiKey);
    }
  }
  const evidence = providerSourceUrls(response);
  const directSources = (job.sources || []).filter(s => s.readable);
  for (const source of directSources) {
    evidence.add(normalizedUrl(source.url));
    if (source.method === 'html' && source.retrievedUrl) evidence.add(normalizedUrl(source.retrievedUrl));
  }
  const inspected = job.scope === 'school' ? [...new Set(directSources.flatMap(s => [s.url, ...(s.method === 'html' && s.retrievedUrl ? [s.retrievedUrl] : [])]).map(normalizedUrl))] : [...new Set([...result.inspectedUrls, ...directSources.map(s => s.url)].map(normalizedUrl))].filter(u => evidence.has(u));
  const gaps = [...result.gaps, ...(job.sourceIssues || [])];
  for (const source of directSources) if (!source.complete) gaps.push(`${source.url}: direct source text was truncated; complete analysis is not confirmed.`);
  if (result.inspectedUrls.some(u => !evidence.has(normalizedUrl(u)))) gaps.push('Some reported source URLs were not present in the provider’s search evidence and were excluded.');
  const checkedIds = new Set(job.scope === 'school' ? [] : result.checkedSchoolIds.filter(id => job!.schoolIds.includes(id)));
  if (job.scope !== 'school') for (const id of job.schoolIds) if (!checkedIds.has(id)) gaps.push(`${desk.schools.find(s => s.id === id)?.name || id}: coverage not confirmed.`);
  const date = new Date().toISOString();
  const db = database();
  // Every write, including the completion marker, shares one atomic batch and the same job revision guard.
  const guard = "EXISTS(SELECT 1 FROM records WHERE id=? AND revision=?)";
  const statements: D1PreparedStatement[] = [];
  const write = (kind: string, id: string, data: unknown, patch: unknown = data, archiveMatches: Opening[] = []) => {
    const ids = [...new Set(archiveMatches.map(o => 'opening:' + o.id))];
    // Recheck within the atomic import: archiving while an API response is being
    // processed must win, including a dismissed draft with a different ID.
    const archiveGuard = ids.length ? ` AND NOT EXISTS(SELECT 1 FROM records WHERE id IN (${ids.map(() => '?').join(',')}) AND json_extract(data,'$.workflow')='Archived' AND (json_extract(data,'$.archiveReason')='user' OR (COALESCE(json_extract(data,'$.archiveReason'),'')!='resolved-draft' AND COALESCE(json_extract(data,'$.verification'),'') NOT LIKE 'Draft%')))` : '';
    statements.push(db.prepare(`INSERT INTO records(id,kind,data,revision,updated_at) SELECT ?,?,?,1,? WHERE ${guard}${archiveGuard}
      ON CONFLICT(id) DO UPDATE SET data=json_patch(records.data,?),revision=records.revision+1,updated_at=excluded.updated_at`).bind(kind + ':' + id, kind, JSON.stringify(data), date, 'meta:' + recordId(job), job.revision, ...ids, JSON.stringify(patch)));
  };
  let added = 0, updated = 0, archived = 0, excluded = 0;
  const excludedItems = new Set<typeof result.openings[number]>();
  const exclusions = new Map<string, { reason: string; stale: boolean }>();
  const exclude = (item: typeof result.openings[number], reason: string, stale = false) => {
    excluded++; excludedItems.add(item);
    const urls = [item.sourceUrl, ...(job!.sources || []).filter(s => [s.url, s.retrievedUrl].includes(item.sourceUrl)).flatMap(s => [s.url, ...(s.method === 'html' && s.retrievedUrl ? [s.retrievedUrl] : [])])];
    for (const url of urls) exclusions.set(normalizedUrl(url), { reason, stale });
  };
  const completedIds = new Set<string>();
  const importedRequests = new Map<string, string>();
  const importedUrls: string[] = [];
  const excludedRequests = new Set<string>();
  for (const item of result.openings) {
    const queuedSource = desk.requests.find(r => r.id === item.sourceRequestId && job.requestIds.includes(r.id) && inspected.includes(normalizedUrl(r.url)));
    const source = job.scope === 'school' ? (job.sources || []).find(s => [s.url, s.retrievedUrl].filter(Boolean).some(u => normalizedUrl(u!) === normalizedUrl(item.sourceUrl))) : (job.sources || []).find(s => s.requestId === (queuedSource?.id || job.requestId));
    if (job.scope === 'school' && (!source?.readable || !source.complete)) {
      gaps.push(`${item.title}: posting was not imported because its full source could not be read (${item.sourceUrl}).`); continue;
    }
    const discovery = job.scope !== 'link' && !queuedSource;
    const document = job.documents?.find(d => d.url === source?.url);
    const outside = discovery && discoveryExclusionReason(item, document || source);
    if (outside && source?.readable && source.complete) { exclude(item, outside); continue; }
    if (job.scope === 'school' && (job.scopePolicyVersion || 0) >= 1) {
      const document = job.documents?.find(d => d.url === source?.url);
      const issue = scopeEvidenceIssue(item, document);
      if (issue) { gaps.push(`${item.title}: not imported because ${issue}.`); continue; }
    }
    if (source && individualPosting(source.url) && (!source.readable || !source.complete ||
      !samePosting(source.url, item.sourceUrl) || (source.method === 'interfolio' && item.applicationUrl && !samePosting(source.url, item.applicationUrl)))) {
      gaps.push(`${item.title}: not imported because it does not establish the exact requested posting.`);
      excludedRequests.add(source.requestId);
      continue;
    }
    let school = desk.schools.find(s => s.id === item.schoolId && (job.schoolIds.includes(s.id) || queuedSource));
    let createdSchool = false;
    if (!school && queuedSource) {
      const proposed = await schoolFromPosting(item, source);
      if (proposed) {
        school = desk.schools.find(s => s.domain.toLowerCase().replace(/^www\./, '') === proposed.domain);
        if (!school) { school = proposed; createdSchool = true; }
      }
    }
    if (school && source && ['ajo', 'interfolio'].includes(source.method) && !institutionMatches(source.institution || '', school)) {
      gaps.push(`${item.title}: the selected school does not match the institution named by the posting.`);
      excludedRequests.add(source.requestId); continue;
    }
    if (!school || !inspected.includes(normalizedUrl(item.sourceUrl)) || !officialSource(item.sourceUrl, school)) { gaps.push(`${item.title}: not imported because its school or official source evidence could not be confirmed.`); if (queuedSource) excludedRequests.add(queuedSource.id); continue; }
    const found = { ...item, schoolId: school.id, department: departmentName(item.department, school) };
    if (source && individualPosting(source.url) && source.readable) {
      found.title = source.title!;
      found.sourceUrl = source.url;
      if (source.method === 'interfolio') found.applicationUrl = source.url;
      else if (source.applicationUrl) found.applicationUrl = source.applicationUrl;
      if (source.location) found.location = source.location;
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
        if (!source.closingText || !found.deadlineText?.includes(source.closingText)) {
          found.deadlineText = [source.closingText, found.deadlineText].filter(Boolean).join('\n');
        }
      }
    }
    // A stale hiring hub can still say 'applications invited' while its exact
    // linked application is closed. Use a uniquely matched, fully read portal
    // rather than treating the hub's continued existence as current hiring.
    const titleKey = (value: string) => value.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().toLowerCase();
    const linkedPostings = (job.sources || []).filter(s => s.readable && s.complete && individualPosting(s.url) &&
      titleKey(s.title || '') === titleKey(found.title) &&
      source?.links?.some(link => /^apply(?:\s|$)/i.test(link.label) && samePosting(link.url, s.url)) &&
      (!found.applicationUrl || samePosting(found.applicationUrl, s.url)));
    const freshnessSource = source && individualPosting(source.url) ? source : linkedPostings.length === 1 ? linkedPostings[0] : source;
    const stale = discovery && staleOpeningReason(found, undefined, freshnessSource);
    if (stale) { exclude(item, stale, true); continue; }
    const linkedApplication = !!found.applicationUrl && !!source?.readable && source.complete && samePosting(source.url, found.sourceUrl) &&
      (source.links || []).some(l => normalizedUrl(l.url) === normalizedUrl(found.applicationUrl!));
    if (found.applicationUrl && ((!evidence.has(normalizedUrl(found.applicationUrl)) && !linkedApplication) || (!officialSource(found.applicationUrl, school) && source?.applicationUrl !== found.applicationUrl))) {
      gaps.push(`${item.title}: the application URL was omitted because its source evidence could not be confirmed.`);
      found.applicationUrl = null;
    }
    const archiveMatches = desk.openings.filter(o => matchesArchivedOpening(o, found));
    const dismissed = archiveMatches.find(userArchived);
    if (dismissed) {
      archived++;
      importedUrls.push(found.sourceUrl, item.sourceUrl, dismissed.sourceUrl, ...importedPostingAliases(job.sources || [], found.applicationUrl));
      if (queuedSource) importedRequests.set(queuedSource.id, school.id);
      continue;
    }
    const old = desk.openings.find(o => !(o.workflow === 'Archived' && o.verification?.startsWith('Draft')) && matchesOpening(o, found));
    const id = old?.id || await hash(openingIdentityKey(found));
    const patch = openingPatch(found, date.slice(0, 10));
    const record = { id, applicationUrl: '', deadline: '', deadlineType: 'Unknown', deadlineText: '', hardDeadline: '', rank: 'Unknown', areas: '', materials: '', letters: '', hiringStatus: 'Unverified', workflow: 'Inbox', notes: '', ...patch } as Opening;
    if (createdSchool) {
      // Another concurrent link may have created this school; never reset its shortlist or notes.
      write('school', school.id, school, {});
      desk.schools.push(school);
    }
    write('opening', id, record, patch, archiveMatches);
    importedUrls.push(found.sourceUrl, item.sourceUrl, ...(old ? [old.sourceUrl] : []), ...importedPostingAliases(job.sources || [], found.applicationUrl));
    if (queuedSource) importedRequests.set(queuedSource.id, school.id);
    if (old) updated++; else added++;
    const i = desk.openings.findIndex(o => o.id === id); if (i >= 0) desk.openings[i] = { ...desk.openings[i], ...patch } as Opening; else desk.openings.push(record);
  }
  for (const [url, decision] of exclusions) {
    // A mixed hub must retain its assessment when it also contains eligible
    // candidates. Excluding one advertisement cannot hide another unread one.
    if (result.openings.some(item => !excludedItems.has(item) && normalizedUrl(item.sourceUrl) === url)) continue;
    const prior = result.sourceReviews.find(r => normalizedUrl(r.url) === url);
    if (prior?.openingUrls.some(candidate => !exclusions.has(normalizedUrl(candidate)))) continue;
    result.sourceReviews = result.sourceReviews.filter(r => normalizedUrl(r.url) !== url);
    result.sourceReviews.push({ url, outcome: decision.stale && !postingPage(url) ? 'no_openings' : 'irrelevant', openingUrls: [], departments: prior?.departments || [], reason: decision.reason });
  }
  for (const id of result.completedRequestIds) {
    const request = desk.requests.find(r => r.id === id && job.requestIds.includes(id));
    if (!request || !inspected.includes(normalizedUrl(request.url))) continue;
    const source = (job.sources || []).find(s => s.requestId === id);
    if (individualPosting(request.url) && !importedRequests.has(id)) {
      gaps.push(`${request.url}: the posting was not imported; search preferences cannot exclude an explicitly added link.`);
      continue;
    }
    if (excludedRequests.has(id) || (source?.readable && !source.complete) || (source && individualPosting(source.url) && (!source.readable || !source.complete))) continue;
    completedIds.add(id);
    const requestPatch = { status: 'Researched', error: '', ...(source?.title ? { title: source.title } : {}), ...(importedRequests.has(id) ? { schoolId: importedRequests.get(id) } : {}) };
    write('request', id, { ...request, ...requestPatch }, requestPatch);
    const draftId = 'opening:intake-' + id;
    statements.push(db.prepare(`UPDATE records SET data=json_set(data,'$.workflow','Archived','$.archiveReason','resolved-draft','$.summary','Research completed. See the research history and opening records.'),revision=revision+1,updated_at=? WHERE id=? AND json_extract(data,'$.workflow')='Inbox' AND json_extract(data,'$.verification') LIKE 'Draft%' AND ${guard}`).bind(date, draftId, 'meta:' + recordId(job), job.revision));
  }
  for (const id of job.requestIds) if (!completedIds.has(id)) gaps.push(`Saved link still awaiting verification: ${desk.requests.find(r => r.id === id)?.url || id}`);
  const targetSchool = desk.schools.find(s => s.id === job.schoolIds[0]);
  const requestedDepartments = targetSchool ? new Set([...targetSchool.departments, ...targetSchool.sources.map(s => s.department)].map(d => departmentName(d, targetSchool).toLowerCase())) : new Set<string>();
  const coverageDepartments = (job.departments || []).filter(d => !discoveryExclusionReason({ department: d.department }) && targetSchool && requestedDepartments.has(departmentName(d.department, targetSchool).toLowerCase()));
  const coverageIssues = job.scope === 'school' ? assessSchoolCoverage(job.sources || [], coverageDepartments, result.sourceReviews, importedUrls, gaps) : [];
  if (job.scope === 'school' && !coverageIssues.length) checkedIds.add(job.schoolIds[0]);
  const finalGaps = job.scope === 'school' ? coverageIssues : gaps;
  const coverage = job.scope === 'link' ? `${completedIds.size}/${job.requestIds.length} links analyzed.` : job.scope === 'school' ? `${checkedIds.size}/1 schools verified against fetched sources.` : `${checkedIds.size}/${job.schoolIds.length} schools reported checked.`;
  const summary = `${added} new, ${updated} updated openings.${archived ? ` ${archived} archived findings kept out of the inbox.` : ''} ${excluded ? ` ${excluded} out-of-scope or expired/previous-cycle postings excluded.` : ''} ${coverage} ${result.summary}`;
  write('run', job.id, { id: job.id, date, summary, checked: inspected.length, newOpenings: added, failures: finalGaps, sources: inspected });
  const done = { ...job, documents: undefined, ...(job.scope === 'school' ? { sourceReviews: result.sourceReviews, importedUrls } : {}), status: 'completed', error: undefined, dispatchBlocked: false, uncertainStart: false, summary, added, updated, checked: inspected.length, gaps: finalGaps.length, coverageIssues: job.scope === 'school' ? coverageIssues : undefined, needsRetry: coverageIssues.length > 0 || job.requestIds.some(id => !completedIds.has(id)) }; delete done.revision;
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

// Reconcile saved coverage when a directly evidenced URL alias was already
// imported. This is a local computation; it never launches another AI request.
export async function reconcileSchoolAliases(jobRecordId: string) {
  const job = await getJob(jobRecordId);
  if (job?.scope !== 'school' || job.status !== 'completed' || !job.needsRetry || !job.importedUrls?.length || !job.coverageIssues?.some(gap => /individual posting must be imported|discovered posting has not been imported/.test(gap))) return;
  const imported = new Set(job.importedUrls.map(normalizedUrl)), desk = await readDesk();
  const aliases = desk.openings.filter(o => job.schoolIds.includes(o.schoolId) && imported.has(normalizedUrl(o.sourceUrl)))
    .flatMap(o => importedPostingAliases(job.sources || [], o.applicationUrl));
  const resolved = new Set(aliases.flatMap(url => [
    `${url}: an individual posting must be imported or explicitly ruled out; it cannot be treated as an empty hiring page.`,
    `${url}: discovered posting has not been imported or explicitly ruled out.`,
  ]));
  const coverageIssues = job.coverageIssues.filter(gap => !resolved.has(gap));
  if (coverageIssues.length === job.coverageIssues.length) return;
  const summary = coverageIssues.length ? job.summary : job.summary.replace('0/1 schools verified', '1/1 schools verified');
  const next = { ...job, importedUrls: [...new Set([...job.importedUrls, ...aliases])], coverageIssues, gaps: coverageIssues.length, needsRetry: coverageIssues.length > 0, summary }; delete next.revision;
  await database().batch([
    database().prepare("UPDATE records SET data=json_set(data,'$.summary',?,'$.failures',json(?)),revision=revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM records WHERE id=? AND revision=?)")
      .bind(summary, JSON.stringify(coverageIssues), 'run:' + job.id, 'meta:' + jobRecordId, job.revision),
    database().prepare('UPDATE records SET data=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?')
      .bind(JSON.stringify(next), new Date().toISOString(), 'meta:' + jobRecordId, job.revision),
  ]);
}

export async function stopTrackingResearch(requestId?: string, apiKey?: string, jobRecordId?: string) {
  const job = await getJob(jobRecordId || (requestId ? 'research-link-' + requestId : 'research'));
  if (job?.status === 'blocked') await updateJob(job, { status: 'failed', summary: 'Stopped tracking this result.', error: 'You can now start again. Research already running at OpenAI was not canceled.' });
  return researchStatus(apiKey);
}
