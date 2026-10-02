import { database, getRecord, readDesk, saveRecord } from './store';
import { getJob, pollAllResearch, pollResearch, reconcileSchoolAliases, researchConfigured, researchStatus, startSchoolResearch, stopTrackingResearch, type Job } from './research';

type Task = { schoolId: string; name: string; attempt: number };
type Sweep = { id: string; scope: 'considering' | 'all'; startedAt: string; tasks: Task[]; pausedAt?: string; revision?: number };
const sweepRecord = 'research-sweep';
const taskKey = (sweep: Sweep, task: Task, attempt = task.attempt) => `research-school-${sweep.id}-${task.schoolId}-${attempt}`;
const readSweep = (): Promise<Sweep | null> => getRecord('meta', sweepRecord);
const inProgress = (job: Job | null) => !!job && ['starting', 'running', 'blocked'].includes(job.status);
async function snapshot(sweep: Sweep) {
  const tasks = await Promise.all(sweep.tasks.map(async task => ({ task, job: await getJob(taskKey(sweep, task)) })));
  const schools = tasks.map(({ task, job }) => ({
    schoolId: task.schoolId, name: task.name, attempt: task.attempt,
    canRecover: job?.status === 'failed' && !!job.responseId,
    status: !job ? 'pending' : job.status === 'completed' ? job.needsRetry ? 'partial' : 'completed' : job.status === 'starting' ? 'running' : job.status,
    summary: job?.summary, issues: [...(job?.coverageIssues || job?.sourceIssues || []), ...(job?.error ? [job.error] : [])],
    sources: (job?.sources || []).map(s => ({ url: s.url, readable: s.readable, complete: s.complete, error: s.error })),
    added: job?.added || 0, updated: job?.updated || 0,
  }));
  // Include prior attempts in totals; retries must not make earlier imported entries disappear.
  const attempts = await Promise.all(sweep.tasks.flatMap(task => Array.from({ length: task.attempt + 1 }, (_, n) => getJob(taskKey(sweep, task, n)))));
  const added = attempts.reduce((n, j) => n + (j?.added || 0), 0), updated = attempts.reduce((n, j) => n + (j?.updated || 0), 0);
  const blocked = tasks.some(({ job }) => job?.status === 'blocked' || job?.uncertainStart || job?.dispatchBlocked);
  const pending = schools.some(s => ['pending', 'running'].includes(s.status));
  const completedSchools = schools.filter(s => s.status === 'completed').length;
  const processedSchools = schools.filter(s => ['completed', 'partial', 'failed'].includes(s.status)).length;
  const partialSchools = schools.filter(s => s.status === 'partial').length;
  const failedSchools = schools.filter(s => s.status === 'failed').length;
  const needsRetry = schools.some(s => ['partial', 'failed', 'blocked'].includes(s.status));
  const status = sweep.pausedAt ? 'paused' : blocked ? 'blocked' : pending ? 'running' : 'completed';
  return { tasks, job: { id: sweep.id, scope: sweep.scope, status, startedAt: sweep.startedAt, schoolCount: schools.length,
    pausedAt: sweep.pausedAt,
    totalSchools: schools.length, completedSchools, processedSchools, partialSchools, failedSchools, schools, requestIds: [], added, updated, needsRetry,
    gaps: schools.reduce((n, s) => n + s.issues.length, 0),
    error: blocked ? 'Search paused because a result needs attention. Restore the original key to resume a blocked result. For a failed school, resolve its API issue and explicitly retry; check API usage first if its start was uncertain.' : undefined,
    summary: `${processedSchools}/${schools.length} schools processed; ${partialSchools} with coverage gaps; ${failedSchools} failed. Complete source coverage: ${completedSchools}/${schools.length}. Across all attempts: ${added} new records, ${updated} updates.` } };
}

export async function sweepStatus(apiKey?: string) {
  const [sweep, legacy] = await Promise.all([readSweep(), researchStatus(apiKey)]);
  if (!sweep) return { ...legacy, job: legacy.job && { ...legacy.job, legacyCoverage: true, needsRetry: true } };
  return { ...legacy, job: (await snapshot(sweep)).job };
}

export async function pauseSweep(apiKey?: string) {
  const sweep = await readSweep();
  if (!sweep) throw new Error('There is no school search to pause.');
  const now = new Date().toISOString();
  // Pause must work even while a slow provider request holds the dispatch lease.
  // Change only the pause field so concurrent task/retry state is preserved.
  await database().prepare("UPDATE records SET data=json_set(data,'$.pausedAt',?),revision=revision+1,updated_at=? WHERE id=? AND json_extract(data,'$.id')=? AND json_extract(data,'$.pausedAt') IS NULL")
    .bind(now, now, 'meta:' + sweepRecord, sweep.id).run();
  return sweepStatus(apiKey);
}

export async function resumeSweep(apiKey?: string) {
  if (!researchConfigured(apiKey)) throw new Error('Add your API key before resuming.');
  const sweep = await readSweep();
  if (!sweep) throw new Error('There is no school search to resume.');
  await database().prepare("UPDATE records SET data=json_remove(data,'$.pausedAt'),revision=revision+1,updated_at=? WHERE id=? AND json_extract(data,'$.id')=? AND json_extract(data,'$.pausedAt') IS NOT NULL")
    .bind(new Date().toISOString(), 'meta:' + sweepRecord, sweep.id).run();
  return pollSweep(apiKey);
}

export async function startSweep(scope: 'considering' | 'all', schoolIds: string[] | undefined, apiKey?: string) {
  if (!researchConfigured(apiKey)) throw new Error('Add your OpenAI API key. No search has started.');
  const old = await readSweep();
  if (old && (await snapshot(old)).job.status !== 'completed') return sweepStatus(apiKey);
  const desk = await readDesk();
  if (schoolIds?.some(id => !desk.schools.some(s => s.id === id))) throw new Error('Choose an existing school.');
  const schools = desk.schools.filter(s => schoolIds?.length ? schoolIds.includes(s.id) : scope === 'all' || s.considering);
  if (!schools.length) throw new Error('Select a school before searching.');
  const next: Sweep = { id: crypto.randomUUID(), scope, startedAt: new Date().toISOString(), tasks: schools.map(s => ({ schoolId: s.id, name: s.name, attempt: 0 })) };
  if (old) {
    try { await saveRecord('meta', sweepRecord, next, old.revision); } catch { return sweepStatus(apiKey); }
  } else {
    const inserted = await database().prepare("INSERT OR IGNORE INTO records(id,kind,data,revision,updated_at) VALUES(?,'meta',?,1,?)")
      .bind('meta:' + sweepRecord, JSON.stringify(next), next.startedAt).run();
    if (!inserted.meta.changes) return sweepStatus(apiKey);
  }
  return pollSweep(apiKey);
}

// A parent lease serializes capacity reservations across tabs/polls. Child claims and
// imports also have their own revision guards. No key or provider response is in the lease.
async function acquire(sweep: Sweep) {
  const id = 'meta:research-dispatch-' + sweep.id, owner = crypto.randomUUID(), now = Date.now();
  const result = await database().prepare(`INSERT INTO records(id,kind,data,revision,updated_at) VALUES(?,'meta',?,1,?)
    ON CONFLICT(id) DO UPDATE SET data=excluded.data,revision=records.revision+1,updated_at=excluded.updated_at
    WHERE json_extract(records.data,'$.until') < ?`).bind(id, JSON.stringify({ owner, until: now + 180000 }), new Date().toISOString(), now).run();
  return result.meta.changes ? { id, owner } : null;
}
async function release(lease: { id: string; owner: string }) {
  await database().prepare("DELETE FROM records WHERE id=? AND json_extract(data,'$.owner')=?").bind(lease.id, lease.owner).run();
}

export async function pollSweep(apiKey?: string) {
  const sweep = await readSweep();
  // Individual links keep their independent analysis and recovery controls.
  if (!sweep) return { ...await pollAllResearch(apiKey), job: (await sweepStatus(apiKey)).job };
  if (sweep.pausedAt) return { ...await pollAllResearch(apiKey), job: (await sweepStatus(apiKey)).job };
  await Promise.all(sweep.tasks.map(task => reconcileSchoolAliases(taskKey(sweep, task))));
  if (!researchConfigured(apiKey)) return sweepStatus(apiKey);
  const lease = await acquire(sweep);
  if (!lease) return sweepStatus(apiKey);
  const errors: string[] = [];
  try {
    const current = await readSweep();
    if (current?.id !== sweep.id || current.pausedAt) return sweepStatus(apiKey);
    let state = await snapshot(current);
    const polling = await Promise.allSettled([
      pollAllResearch(apiKey),
      ...state.tasks.filter(({ job }) => inProgress(job)).map(({ task }) => pollResearch(taskKey(current, task), apiKey)),
    ]);
    for (const result of polling) {
      if (result.status === 'rejected') errors.push((result.reason as Error).message);
      else if ('errors' in result.value) errors.push(...(result.value.errors as string[] || []));
    }
    // An explicit pause can arrive while the provider is responding. Finish
    // saving that result, but do not advance to another school.
    const afterPolling = await readSweep();
    if (afterPolling?.id !== current.id || afterPolling.pausedAt) return sweepStatus(apiKey);
    state = await snapshot(afterPolling);
    // A transient provider failure or inaccessible/uncertain result must not launch more spending.
    if (!errors.length && state.job.status !== 'blocked') {
      const capacity = Math.max(0, 2 - state.tasks.filter(({ job }) => inProgress(job)).length);
      const starting = state.tasks.filter(({ job }) => !job).slice(0, capacity);
      const launched = await Promise.allSettled(starting.map(({ task }) => startSchoolResearch(task.schoolId, taskKey(current, task), apiKey)));
      for (const result of launched) if (result.status === 'rejected') errors.push((result.reason as Error).message);
    }
    state = await snapshot(current);
    if (state.job.status === 'completed') {
      const date = new Date().toISOString();
      const runId = current.id + '-attempts-' + current.tasks.reduce((n, t) => n + t.attempt, 0);
      const run = { id: runId, date, summary: state.job.summary,
        checked: state.job.schools.reduce((n, s) => n + s.sources.filter(x => x.readable && x.complete).length, 0),
        newOpenings: state.job.added, failures: state.job.schools.flatMap(s => s.issues.map(i => `${s.name}: ${i}`)),
        sources: [...new Set(state.job.schools.flatMap(s => s.sources.filter(x => x.readable).map(x => x.url)))] };
      // Repeated idle polls do not create duplicate history entries or revisions.
      await database().prepare("INSERT OR IGNORE INTO records(id,kind,data,revision,updated_at) VALUES(?,'run',?,1,?)").bind('run:' + runId, JSON.stringify(run), date).run();
    }
  } finally { await release(lease); }
  return { ...await sweepStatus(apiKey), errors };
}

export async function retrySchools(schoolId: string | undefined, apiKey?: string) {
  if (!researchConfigured(apiKey)) throw new Error('Add your API key before retrying.');
  const sweep = await readSweep();
  if (!sweep) throw new Error('Start a new school-by-school search to replace the earlier unverified search.');
  if (sweep.pausedAt) return sweepStatus(apiKey);
  if (schoolId && !sweep.tasks.some(t => t.schoolId === schoolId)) throw new Error('That school is not in this search.');
  const lease = await acquire(sweep);
  if (!lease) return sweepStatus(apiKey);
  try {
    const current = await readSweep();
    if (current?.id !== sweep.id || current.revision !== sweep.revision) return sweepStatus(apiKey);
    const state = await snapshot(current);
    const retry = state.tasks.filter(({ task, job }) => (!schoolId || task.schoolId === schoolId) && !!job && (job.status === 'failed' || (job.status === 'completed' && (job.needsRetry || !!schoolId))));
    if (!retry.length) return sweepStatus(apiKey);
    const ids = new Set(retry.map(x => x.task.schoolId));
    await saveRecord('meta', sweepRecord, { ...current, tasks: current.tasks.map(t => ids.has(t.schoolId) ? { ...t, attempt: t.attempt + 1 } : t) }, current.revision);
  } finally { await release(lease); }
  return pollSweep(apiKey);
}

export async function stopSchoolTracking(schoolId: string, apiKey?: string) {
  const sweep = await readSweep();
  const task = sweep?.tasks.find(t => t.schoolId === schoolId);
  if (!sweep || !task) throw new Error('That school is not in this search.');
  const lease = await acquire(sweep);
  if (!lease) return sweepStatus(apiKey);
  try {
    const current = await readSweep();
    if (current?.id === sweep.id && current.revision === sweep.revision)
      await stopTrackingResearch(undefined, apiKey, taskKey(sweep, task));
  } finally { await release(lease); }
  return sweepStatus(apiKey);
}

export async function recoverSchool(schoolId: string, apiKey?: string) {
  if (!researchConfigured(apiKey)) throw new Error('Add the API key used for this search to retrieve its saved result.');
  const sweep = await readSweep();
  const task = sweep?.tasks.find(t => t.schoolId === schoolId);
  if (!sweep || !task) throw new Error('That school is not in this search.');
  const lease = await acquire(sweep);
  if (!lease) return sweepStatus(apiKey);
  try {
    const current = await readSweep();
    if (current?.id !== sweep.id || current.revision !== sweep.revision) return sweepStatus(apiKey);
    await pollResearch(taskKey(current, task), apiKey, true);
  }
  finally { await release(lease); }
  return sweepStatus(apiKey);
}
