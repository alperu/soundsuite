/** @jest-environment node */
/**
 * Cross-package drift guard.
 *
 * `sideCar/` is a SEPARATE package published to its own public mirror, so
 * `sideCar/src/lib/virtual-inference.ts` cannot import this repo's curated
 * catalogue. It therefore mirrors two tables by hand:
 *
 *   KNOWN_PROVIDER_PINS  — which provider embedding calls are pinned to
 *   KNOWN_DIMS           — the expected embedding width
 *
 * Hand-mirrored constants drift silently, and these two are the dangerous kind:
 *
 *   - A stale DIMS entry means the sidecar enforces the wrong width. The whole
 *     point of `expectedDims` is to stop a wrong-width vector reaching
 *     `VectorStore.addChunks()`, which drops and recreates the table on a schema
 *     mismatch. A wrong guard is worse than none, because it looks safe.
 *   - A stale PIN means embeddings silently route to a different provider, and
 *     two providers serving one model do not guarantee identical vectors — one
 *     logical vector space quietly becomes two, degrading recall with no error.
 *
 * So this reads the sidecar source as TEXT (no cross-package import) and asserts
 * it still agrees with `../models`. If you change a pin or a dimension here,
 * this test tells you to change it there too.
 */
import * as fs from 'fs';
import * as path from 'path';
import { OPENROUTER_EMBEDDING_MODELS, OPENROUTER_RERANK_MODELS } from '../models';

const SIDECAR_FILE = path.join(process.cwd(), 'sideCar/src/lib/virtual-inference.ts');

/** Parse a `Record<string, X>` object literal out of the sidecar source. */
function parseTable(src: string, name: string): Record<string, string> {
  const start = src.indexOf(`const ${name}`);
  if (start === -1) throw new Error(`${name} not found in ${SIDECAR_FILE} — was it renamed?`);
  const open = src.indexOf('{', start);
  const close = src.indexOf('};', open);
  const body = src.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = line.match(/['"]([^'"]+)['"]\s*:\s*['"]?([^,'"]+)['"]?\s*,/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

describe('sidecar mirrors the curated OpenRouter constants', () => {
  const src = fs.readFileSync(SIDECAR_FILE, 'utf8');

  it('pins every curated embedding model to the same provider as the master', () => {
    const pins = parseTable(src, 'KNOWN_PROVIDER_PINS');
    for (const m of OPENROUTER_EMBEDDING_MODELS) {
      // Only models the sidecar knows about need to agree; it deliberately
      // carries a subset (the ones a sidecar role can fall back to).
      if (!(m.id in pins)) continue;
      expect(`${m.id}=${pins[m.id]}`).toBe(`${m.id}=${m.pinProvider}`);
    }
  });

  it('pins every curated rerank model to the same provider as the master', () => {
    const pins = parseTable(src, 'KNOWN_PROVIDER_PINS');
    for (const m of OPENROUTER_RERANK_MODELS) {
      if (!(m.id in pins)) continue;
      expect(`${m.id}=${pins[m.id]}`).toBe(`${m.id}=${m.pinProvider}`);
    }
  });

  it('carries the same MEASURED dimensions as the master catalogue', () => {
    const dims = parseTable(src, 'KNOWN_DIMS');
    for (const m of OPENROUTER_EMBEDDING_MODELS) {
      if (!(m.id in dims)) continue;
      expect(`${m.id}=${dims[m.id]}`).toBe(`${m.id}=${m.dims}`);
    }
  });

  it('does not mirror a model the master catalogue has dropped', () => {
    const known = new Set([
      ...OPENROUTER_EMBEDDING_MODELS.map((m) => m.id),
      ...OPENROUTER_RERANK_MODELS.map((m) => m.id),
    ]);
    for (const id of Object.keys(parseTable(src, 'KNOWN_PROVIDER_PINS'))) {
      // A model removed from the curated list (e.g. its provider withdrew) must
      // not linger in the sidecar, or the sidecar keeps routing to something the
      // master has already judged unavailable.
      expect(known.has(id)).toBe(true);
    }
  });
});
