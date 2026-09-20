import { intake } from './intake';
import { database, getRecord, readDesk } from './store';
import { researchConfigured, startResearch } from './research';

export async function addSource(url: string, apiKey?: string) {
  // The AI reads the source. Save promptly rather than waiting for a second HTML fetch.
  const result = await intake(url, await readDesk(), false);
  if (!result.existing) {
    const date = new Date().toISOString();
    await database().batch([
      ['request', result.request!], ['opening', result.opening!],
    ].map(([kind, record]) => {
      const data = record as { id: string };
      return database().prepare('INSERT OR IGNORE INTO records(id,kind,data,revision,updated_at) VALUES(?,?,?,1,?)')
        .bind(kind + ':' + data.id, kind, JSON.stringify(data), date);
    }));
  }
  const saved = result.request && await getRecord('request', result.request.id);
  if (!saved || saved.status === 'Researched') return { ...result, analysis: { status: 'existing' } };
  if (!researchConfigured(apiKey)) return { ...result, analysis: { status: 'setup_needed', error: 'Link saved. Connect an OpenAI API key to analyze it.' } };
  try {
    const state = await startResearch('link', saved.id, false, apiKey);
    return { ...result, analysis: state.links.find(j => j.requestId === saved.id) || (state.job?.requestIds.includes(saved.id) ? state.job : { status: 'existing' }) };
  } catch (e) {
    // Saving succeeded. Report analysis failure separately so a retry cannot overwrite the draft.
    return { ...result, analysis: { status: 'failed', error: (e as Error).message } };
  }
}
