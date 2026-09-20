import { mkdir, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
process.env.FACULTY_DESK_LOCAL_ONLY = '1';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = 'false';
// Local mode exclusively uses the key entered by the user in their browser.
delete process.env.OPENAI_API_KEY;
await mkdir('.local-data', { recursive: true, mode: 0o700 });
await writeFile('.local-data/wrangler.json', JSON.stringify({
  name: 'faculty-search-desk-local',
  compatibility_date: '2026-09-20',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: [{
    binding: 'DB', database_name: 'faculty-search-desk-local',
    database_id: '00000000-0000-4000-8000-000000000000',
    migrations_dir: '../drizzle',
  }],
}, null, 2));

const migration = spawnSync(process.execPath, [
  '--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js',
  'd1', 'migrations', 'apply', 'DB', '--local',
  '--config', '.local-data/wrangler.json', '--persist-to', '.local-data/state',
], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);
if (process.argv.includes('--setup-only')) process.exit(0);

const { createServer } = await import('vite');
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5173, strictPort: true } });
await server.listen();
console.log('\nFaculty Search Desk: http://127.0.0.1:5173/');
console.log('Keep this terminal open. Press Ctrl+C to stop. Your records stay in .local-data/.\n');
if (process.argv.includes('--open') && process.platform === 'darwin') {
  const browser = spawn('open', ['http://127.0.0.1:5173/'], { stdio: 'ignore' });
  browser.on('error', () => console.log('Open http://127.0.0.1:5173/ in your browser.'));
}
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
});
