import type { ResearchResult } from './research-result';
import type { SourceDocument, SourceReceipt } from './research-source';

export const DEFAULT_RESEARCH_SCOPE = 'Tenure-track assistant professor in Computer Science (CS/CSE), Artificial Intelligence (AI), Machine Learning (ML), Statistics, or Data Science. Exclude biostatistics, business/management schools, psychology, medicine/public health, and discipline-specific roles that merely apply AI or statistics. ECE/EECS and mathematics roles qualify only for a central CS/AI/ML/statistics/data-science hire. Keep other ranks labeled.';
export const RESEARCH_AREA_LABEL = 'CS · AI · ML · Statistics · Data Science';
export const researchAreaTerms = /\b(?:computer science|computing|artificial intelligence|machine learning|reinforcement learning|deep learning|probability|software engineering|programming languages|distributed systems|operating systems|databases|cybersecurity|computer security|computer vision|natural language processing|human.computer interaction|statistic(?:s|al)|data science|data-science|CS|CSE|AI|ML)\b/i;
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const excludedUnit = /\b(?:biostat(?:istic\w*|s)?|bio-stat(?:istic\w*|s)?|psycholog\w*|psychiatr\w*|business|wharton|kellogg|sloan|booth|haas|stern|management|marketing|finance|accounting|economics|econometrics|public health|epidemiolog\w*|medicine|medical|nursing|education|physics|chemistry|biology)\b/i;
type Subject = { title?: string | null; department?: string | null; sourceUrl?: string | null };

export function discoveryExclusionReason(item: Subject, source?: Partial<SourceDocument>) {
  const unit = [item.department, source?.institution].filter(Boolean).join(' ');
  const role = [item.title, source?.title].filter(Boolean).join(' ');
  const excludedRole = /\b(?:biostat(?:istic\w*|s)?|bio-stat(?:istic\w*|s)?|psycholog\w*|psychiatr\w*|business|wharton|kellogg|sloan|booth|haas|stern|marketing|finance|accounting|economics|econometrics|public health|epidemiolog\w*|medicine|medical|nursing|physics|chemistry|biology)\b/i;
  if (excludedUnit.test(unit) || excludedRole.test(role) || /\b(?:school|college|department) of (?:management|education)\b/i.test(role)) return 'The advertised role or hiring unit is outside CS, AI, ML, statistics and data science discovery preferences.';
  if (item.sourceUrl) {
    const u = new URL(item.sourceUrl);
    if (/(?:^|[./_-])(?:biostat(?:istics)?|psych(?:ology)?|business|hbs|gsb|wharton|sloan|kellogg|booth|stern|haas)(?:[./_-]|$)/i.test(u.hostname + u.pathname))
      return 'The posting belongs to an excluded hiring unit (biostatistics, business or psychology).';
  }
  // Hiring-unit statements count; a collaboration or an incidental mention of
  // another department elsewhere in a CS advertisement does not.
  const hiringUnit = source?.text?.match(/(?:department|school|college|division) of [^.\n;]{0,100}?(?:invites applications|seeks|is seeking|is recruiting|is hiring)/gi) || [];
  if (hiringUnit.some(s => excludedUnit.test(s))) return 'The stated hiring unit is outside the selected discovery subjects.';
  return null;
}

export function scopeEvidenceIssue(item: ResearchResult['openings'][number], source?: SourceDocument) {
  const fit = item.scopeEvidence;
  if (!fit || !fit.reason.trim() || !fit.quote.trim()) return 'the central research-area fit was not established';
  if (!source?.readable || !source.complete) return 'the research-area evidence has no complete posting text';
  const quote = normalized(fit.quote);
  if (quote.length < 10 || !normalized(source.text).includes(quote)) return 'the research-area evidence does not match this posting';
  if (!researchAreaTerms.test(fit.quote)) return 'the quoted passage does not establish a CS, AI, ML, statistics, or data-science hiring focus';
  return null;
}

type DatedOpening = { title?: string | null; hiringStatus?: string | null; hardDeadline?: string | null; deadline?: string | null; deadlineType?: string | null; deadlineText?: string | null; summary?: string | null };
// With date-only deadlines, wait until that day has ended everywhere rather
// than expiring a US posting while it is still evening locally.
export const researchCalendarDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Etc/GMT+12', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
export function staleOpeningReason(item: DatedOpening, today = researchCalendarDate(), source?: SourceReceipt) {
  if ((source?.status || item.hiringStatus) === 'Closed') return 'The official posting is closed.';
  const hard = source?.closingDate || item.hardDeadline || (/^(?:Application|Final|Hard) deadline$/i.test(item.deadlineType || '') ? item.deadline : null);
  if (hard && hard < today) return `The application deadline passed (${hard}).`;
  // A recent portal opening or future hard close is stronger than an old review
  // date copied from a template. Priority/review dates are never hard closures.
  const year = Number(today.slice(0, 4)), cycleYear = Number(today.slice(5, 7)) >= 7 ? year : year - 1;
  const cycleStart = `${cycleYear}-07-01`;
  if ((source?.openDate && source.openDate >= cycleStart) || (hard && hard >= today) || (item.deadline && item.deadline >= today)) return null;
  const titleYears = [...(item.title || '').matchAll(/\b(20\d{2})(?:[-–/]\s*(20\d{2}|\d{2}))?\b/g)].map(m => m[2] ? Number(m[2].length === 2 ? '20' + m[2] : m[2]) : Number(m[1]));
  if (titleYears.length && Math.max(...titleYears) <= cycleYear) return 'The title identifies an earlier hiring cycle; a current search has not been established.';
  if (item.deadline && item.deadline < cycleStart) return `Only a previous-cycle review date is known (${item.deadline}); current hiring has not been established.`;
  const text = [item.summary, item.deadlineText].filter(Boolean).join(' ');
  const start = /(?:start(?:ing|s)?|begin(?:ning|s)?|commenc(?:ing|es)|effective)[^.!?\n]{0,50}?\b(?:July|August|September|fall|autumn)(?:\s+\d{1,2},?)?\s+(20\d{2})\b/i.exec(text);
  if (start && Number(start[1]) <= cycleYear) return 'The stated appointment start belongs to an earlier hiring cycle; a current search has not been established.';
  return null;
}
