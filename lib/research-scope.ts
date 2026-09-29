import type { ResearchResult } from './research-result';
import type { SourceDocument } from './research-source';

export const DEFAULT_RESEARCH_SCOPE = 'Tenure-track assistant professor in Computer Science (CS/CSE), Artificial Intelligence (AI), Machine Learning (ML), Statistics, Biostatistics, Data Science, and closely related computing fields. Include adjacent-department roles only when one of these is a central advertised hiring focus, not merely a tool used in another discipline. ECE/EECS roles must meet the same subject requirement. Keep other ranks labeled.';
export const RESEARCH_AREA_LABEL = 'CS · AI · ML · Statistics · Data Science';
export const researchAreaTerms = /\b(?:computer science|computing|computer engineering|artificial intelligence|machine learning|reinforcement learning|deep learning|probability|software engineering|programming languages|distributed systems|operating systems|databases|cybersecurity|computer security|computer vision|natural language processing|human.computer interaction|statistic(?:s|al)|biostatistic(?:s|al)|data science|data-science|CS|CSE|AI|ML)\b/i;
const normalized = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

export function scopeEvidenceIssue(item: ResearchResult['openings'][number], source?: SourceDocument) {
  const fit = item.scopeEvidence;
  if (!fit || !fit.reason.trim() || !fit.quote.trim()) return 'the central research-area fit was not established';
  if (!source?.readable || !source.complete) return 'the research-area evidence has no complete posting text';
  const quote = normalized(fit.quote);
  if (quote.length < 10 || !normalized(source.text).includes(quote)) return 'the research-area evidence does not match this posting';
  if (!researchAreaTerms.test(fit.quote)) return 'the quoted passage does not establish a CS, AI, ML, statistics, or data-science hiring focus';
  return null;
}
