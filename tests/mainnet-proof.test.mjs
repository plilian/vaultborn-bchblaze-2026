// The Mainnet transaction proof in docs/mainnet/ checks out offline: TXIDs, Merkle branches, proof of work, the launch
// manifest hash and the War Chest contract rebuilt from this repository. A changed manifest is caught.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = new URL('../scripts/verify-mainnet-proof.mjs', import.meta.url);

test('the Mainnet proof verifies offline', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(script)], { encoding: 'utf8' });
  assert.match(out, /All checks passed\./);
  assert.equal((out.match(/^ok /gm) ?? []).length, 26);
  assert.doesNotMatch(out, /FAIL/);
});

test('a manifest that differs from the launch record is refused', () => {
  const folder = mkdtempSync(join(tmpdir(), 'vb-proof-'));
  try {
    copyFileSync(new URL('../docs/mainnet/transactions.json', import.meta.url), join(folder, 'transactions.json'));
    const manifest = JSON.parse(readFileSync(new URL('../docs/mainnet/launch-manifest.json', import.meta.url), 'utf8'));
    writeFileSync(join(folder, 'launch-manifest.json'), JSON.stringify({ ...manifest, priceBook: 'prices-v3' }));
    const run = spawnSync(process.execPath, [fileURLToPath(script), folder], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL {2}the data output is VBLN v1\.0 with the SHA-256 of the launch manifest/);
    assert.match(run.stdout, /1 check\(s\) failed\./);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
