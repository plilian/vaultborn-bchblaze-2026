// Runs the owner-operated attestors: every attestor key in a folder reviews and signs, as its own process with its own
// key, pin file and evidence folder, once a minute. It writes status.json next to the keys for the launcher to show.
// These attestors are operated by the game's owner. They perform every check an attestor performs (battle replay,
// season audit), but they are NOT independent of the operator, and nothing here pretends otherwise.
//   node scripts/attestor-supervisor.mjs <game origin> <folder with attestor-N.key> [--once]
import { execFile } from 'node:child_process';
import { readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const [origin, folder] = process.argv.slice(2).filter(item => !item.startsWith('--'));
const once = process.argv.includes('--once');
if (!origin || !folder) throw new Error('Usage: node scripts/attestor-supervisor.mjs <game origin> <attestor key folder> [--once]');
const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const interval = Number(process.env.VAULTBORN_ATTESTOR_INTERVAL_MS) || 60_000;
const history = new Map();

async function round() {
  const keys = readdirSync(folder).filter(name => /^attestor-\d+\.key$/.test(name)).sort();
  const attestors = [];
  for (const name of keys) {
    const index = Number(name.match(/\d+/)[0]);
    const entry = history.get(index) ?? { index, runs: 0, signed: 0, refused: 0 };
    try {
      const { stdout } = await run(process.execPath, ['scripts/prize-attest.mjs', origin, '--approve'], { cwd: root, timeout: 120_000, maxBuffer: 8_000_000,
        env: { ...process.env, NODE_NO_WARNINGS: '1', PRIZE_ATTESTOR_KEY_FILE: join(folder, name), PRIZE_ATTESTOR_PINS: join(folder, `attestor-${index}-pins.json`), PRIZE_ATTESTOR_BUNDLE_DIR: join(folder, `attestor-${index}-bundles`) } });
      entry.signed += (stdout.match(/^attested /gm) ?? []).length;
      entry.refused += (stdout.match(/"problems": \[\s*"/g) ?? []).length;
      Object.assign(entry, { ok: true, error: null, lastRun: Date.now(), runs: entry.runs + 1, idle: /No award is waiting/.test(stdout) });
    } catch (error) { const lines = String(error.stderr || error.message).trim().split('\n');
      Object.assign(entry, { ok: false, error: (lines.find(line => /Error:|fetch failed|ECONNREFUSED/.test(line)) ?? lines.at(-1)).trim().slice(0, 240), lastRun: Date.now(), runs: entry.runs + 1 }); }
    history.set(index, entry);
    attestors.push(entry);
  }
  const file = join(folder, 'status.json');
  writeFileSync(file + '.tmp', JSON.stringify({ updatedAt: Date.now(), origin, operation: 'owner-operated (not independent)', attestors }, null, 2));
  renameSync(file + '.tmp', file);
  return attestors.every(entry => entry.ok);
}
for (;;) {
  const healthy = await round().catch(error => { console.error(new Date().toISOString(), error.message); return false; });
  if (once) break;
  // A failed round (the game was still starting, the network blinked) is repeated soon instead of a minute later.
  await new Promise(done => setTimeout(done, healthy ? interval : 5_000));
}
