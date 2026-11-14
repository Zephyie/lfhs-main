// Builds a temp library folder from the REAL sample shard (made by scripts/ingest.mjs from three real PDFs)
// plus three small SYNTHETIC shards (class 10 physics, class 9 biology, class 8 science) so cross-subject / cross-class behaviour can be tested.
import { mkdtempSync, cpSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function makeLibrary({ real = true, synthetic = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lfhs-kb-'));
  if (real) cpSync('tests/fixtures/kb', dir, { recursive: true });
  if (synthetic) for (const f of readdirSync('tests/fixtures/kb-synthetic')) cpSync(join('tests/fixtures/kb-synthetic', f), join(dir, f));
  return dir;
}
