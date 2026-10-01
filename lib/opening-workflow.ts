import { database, getRecord } from './store';

export async function setOpeningWorkflow(id: string, workflow: string) {
  if (!['Inbox', 'Considering', 'Preparing', 'Applied', 'Interviewing', 'Offer', 'Archived'].includes(workflow)) throw new Error('Invalid workflow');
  // Update only the user's decision, preserving any research imported since
  // this card was displayed. This also makes repeated archive clicks harmless.
  const expression = workflow === 'Archived'
    ? "json_set(data,'$.workflow',?,'$.archiveReason','user')"
    : "json_remove(json_set(data,'$.workflow',?),'$.archiveReason')";
  const changed = await database().prepare(`UPDATE records SET data=${expression},revision=revision+1,updated_at=? WHERE id=? AND kind='opening'`)
    .bind(workflow, new Date().toISOString(), 'opening:' + id).run();
  if (!changed.meta.changes) throw new Error('Opening not found');
  return getRecord('opening', id);
}
