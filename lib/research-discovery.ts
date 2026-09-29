import { canonical } from './intake';
import { readResearchSource, postingPage, type SourceDocument } from './research-source';
import type { Opening, School } from './types';

export type SchoolDiscovery = {
  documents: SourceDocument[];
  issues: string[];
  departments: { department: string; sourceUrls: string[]; issues: string[] }[];
};

type Candidate = { url: string; depth: number; priority: number; departments: Set<string>; read: boolean };
const MAX_DOCUMENTS = 12, MAX_DEPTH = 2, CONCURRENCY = 3, SOFT_BUDGET_MS = 45_000;
const faculty = /\b(?:faculty|professor|tenure[-\s–]?(?:track|eligible)|lecturer|academic (?:jobs|positions|careers))\b/i;
const nonFaculty = /\b(?:post[-\s]?doc(?:toral)?|fellow(?:ship)?|research (?:associate|assistant)|graduate assistant|staff scientist|student|internship|ph\.?d\.? studentship)\b/i;
const utility = /^(?:bookmark|log ?in|sign ?in|create (?:an? )?account|privacy(?: policy)?|accessibility|contact(?: us)?|campus map|directions|copyright|terms(?: of use)?|skip to .+|back|previous|prev|home|print(?: .+)?|share(?: .+)?)$/i;
const generic = /^(?:view (?:details|posting|job)|details(?: and requirements)?|read more|learn more|more (?:information|details)|(?:full(?: job|position)? )?(?:advertisement|announcement|job description)|apply(?: (?:now|here|online))?|click here|here)$/i;

function departmentKey(value: string) {
  const aliases: Record<string, string> = { 'computer science': 'cs', 'computer science and engineering': 'cse', 'electrical and computer engineering': 'ece', 'electrical engineering and computer science': 'eecs' };
  const key = value.trim().toLowerCase(); return aliases[key] || key;
}

function applicationForm(value: string) {
  try {
    return /\/(?:login|sign[-_]?in|pre_apply|apply|applications?\/(?:new|start)|users\/(?:new|sign_in))(?:\/|$)/i.test(new URL(value).pathname);
  } catch { return false; } // Invalid saved destinations are reported by enqueue.
}


function pagination(link: URL, current: URL, label: string) {
  if (link.origin !== current.origin) return false;
  const keys = [...new Set([...link.searchParams.keys(), ...current.searchParams.keys()])].filter(k => /^(?:page|pagenumber|pagenum|start|offset)$/i.test(k));
  if (keys.length && link.pathname === current.pathname) {
    return keys.some(key => {
      const initial = /^(?:start|offset)$/i.test(key) ? '0' : '1';
      const from = current.searchParams.get(key) ?? initial, to = link.searchParams.get(key) ?? initial;
      return /^\d+$/.test(from) && /^\d+$/.test(to) && Number(to) > Number(from);
    });
  }
  return (/^(?:next(?: page)?|older(?: (?:posts|positions|jobs))?|\d+|[›»→])(?:\s*[›»→])?$/i.test(label) &&
      (link.pathname === current.pathname || /\/(?:page|pages)\/\d+\/?$/i.test(link.pathname)));
}

// Group aliases before filtering. A postdoc title and a generic "View Details"
// pointing to the same page must not turn into contradictory crawl decisions.
function candidates(document: SourceDocument) {
  const grouped = new Map<string, string[]>();
  for (const link of document.links || []) {
    try {
      const url = canonical(link.url), labels = grouped.get(url) || [];
      labels.push(link.label.trim()); grouped.set(url, labels);
    } catch { /* The source reader normally removes non-public URL forms. */ }
  }
  const page = new URL(document.retrievedUrl || document.url);
  const facultyContext = faculty.test(`${document.title || ''}\n${document.text.slice(0, 4000)}`);
  const results: { url: string; priority: number }[] = [];
  for (const [url, labels] of grouped) {
    if (url === document.url || url === document.retrievedUrl) continue;
    const target = new URL(url), useful = labels.filter(label => !utility.test(label));
    if (!useful.length || applicationForm(url) || /\/(?:bookmarks?|privacy|accessibility|maps?)(?:\/|$)/i.test(target.pathname)) continue;
    const descriptive = useful.filter(label => !generic.test(label));
    const description = descriptive.join(' ');
    if (nonFaculty.test(description) && !faculty.test(description)) continue;
    if (pagination(target, page, useful.join(' '))) { results.push({ url, priority: 2 }); continue; }
    // Numeric portal destinations and explicit faculty advertisements are useful
    // even if the link label is only "View Details" or the page title is generic.
    if (postingPage(url)) { results.push({ url, priority: 1 }); continue; }
    const hiringPath = /(?:facult[y]|careers?|employment|job[-_]?opportunit|academic[-_]?positions|faculty[-_]?search|recruit(?:ment|ing)|open[-_]?positions)/i.test(target.pathname);
    const positionTitle = /\b(?:(?:assistant|associate|full|visiting|research|teaching) professor|professorship|tenure[-\s–]?track|open[-\s]?rank|lecturer)\b/i.test(description);
    const instructions = /\b(?:(?:application|applicant) (?:instructions|requirements|materials|process|information)|how to apply)\b/i.test(description);
    if (positionTitle || (facultyContext && instructions) ||
      (faculty.test(description) && (hiringPath || /\b(?:position|opening|search|hiring|career|apply|opportunit|vacanc)/i.test(description))) ||
      (facultyContext && (hiringPath || useful.some(label => generic.test(label))))) {
      results.push({ url, priority: hiringPath ? 3 : 1 });
    }
  }
  return results;
}

/** Reads each school's saved hiring sources and bounded, relevant descendants.
 * Returned issues are unresolved coverage gaps, not warnings that can be ignored
 * when marking a school checked. Full source text is transient model input only.
 */
export async function discoverSchoolSources(school: School, knownOpenings: Opening[]): Promise<SchoolDiscovery> {
  const started = Date.now();
  const documents: SourceDocument[] = [], issues: string[] = [];
  const departments = school.departments.map(department => ({ department, sourceUrls: [] as string[], issues: [] as string[] }));
  const queue: Candidate[] = [], seen = new Map<string, Candidate>();
  const department = (name: string) => {
    let item = departments.find(d => departmentKey(d.department) === departmentKey(name));
    if (!item) { item = { department: name || 'Unassigned', sourceUrls: [], issues: [] }; departments.push(item); }
    return item;
  };
  const issue = (message: string, names: Iterable<string>) => {
    if (!issues.includes(message)) issues.push(message);
    for (const name of names) { const item = department(name); if (!item.issues.includes(message)) item.issues.push(message); }
  };
  const enqueue = (rawUrl: string, depth: number, priority: number, names: Iterable<string>) => {
    const scope = [...names];
    let url: string;
    try { url = canonical(rawUrl); }
    catch { issue(`Invalid hiring source: ${rawUrl}`, scope); return; }
    const old = seen.get(url);
    if (old) { for (const name of scope) old.departments.add(name); return; }
    if (depth > MAX_DEPTH) { issue(`Discovery depth limit left a relevant link unread: ${url}`, scope); return; }
    const item: Candidate = { url, depth, priority, departments: new Set(scope), read: false };
    seen.set(url, item); queue.push(item);
  };
  for (const source of school.sources) enqueue(source.url, 0, 0, [department(source.department).department]);
  for (const item of [...departments]) {
    if (!school.sources.some(s => departmentKey(s.department) === departmentKey(item.department))) {
      issue(`No saved hiring source for ${item.department}.`, [item.department]);
    }
  }
  if (!departments.length) issue('No departments or hiring sources are configured.', []);
  for (const opening of knownOpenings) {
    if (opening.schoolId !== school.id || /^archived$/i.test(opening.workflow)) continue;
    // Saved leads do not add required departments to the configured search scope.
    const names = departments.filter(d => departmentKey(d.department) === departmentKey(opening.department)).map(d => d.department);
    // Keep the saved advertisement as evidence even if it now redirects to a
    // login. A separate sign-in/application form is not a missing advertisement.
    if (opening.sourceUrl) enqueue(opening.sourceUrl, 0, 1, names);
    if (opening.applicationUrl && !applicationForm(opening.applicationUrl)) enqueue(opening.applicationUrl, 0, 1, names);
  }

  while (queue.length && documents.length < MAX_DOCUMENTS && Date.now() - started < SOFT_BUDGET_MS) {
    queue.sort((a, b) => a.priority - b.priority || a.depth - b.depth);
    const batch = queue.splice(0, Math.min(CONCURRENCY, MAX_DOCUMENTS - documents.length));
    const read = await Promise.all(batch.map((item, index) => readResearchSource({ id: `school:${school.id}:${documents.length + index}`, url: item.url })));
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index], document = read[index]; item.read = true; documents.push(document);
      if (!document.readable) { issue(`Could not read ${item.url}: ${document.error || 'No readable content.'}`, item.departments); continue; }
      if (!document.complete) issue(`Source text was truncated: ${item.url}`, item.departments);
      if (document.linkLimitReached) issue(`Source link limit may hide additional postings: ${item.url}`, item.departments);
      for (const link of candidates(document)) enqueue(link.url, item.depth + 1, link.priority, item.departments);
    }
  }
  const reason = documents.length >= MAX_DOCUMENTS ? `Discovery page limit (${MAX_DOCUMENTS})` : 'Discovery time limit';
  for (const pending of queue) issue(`${reason} left a relevant link unread: ${pending.url}`, pending.departments);
  // Shared hubs can be discovered for another department after they were read.
  // Resolve associations at the end rather than freezing them at fetch time.
  for (const document of documents) {
    const item = seen.get(document.url)!;
    for (const name of item.departments) {
      const target = department(name);
      if (!target.sourceUrls.includes(document.url)) target.sourceUrls.push(document.url);
      for (const message of issues.filter(value => value.includes(document.url))) if (!target.issues.includes(message)) target.issues.push(message);
    }
  }
  return { documents, issues, departments };
}
