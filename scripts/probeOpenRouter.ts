#!/usr/bin/env tsx
/**
 * probeOpenRouter.ts — CI availability probe for the curated OpenRouter catalogue.
 *
 *   npx tsx scripts/probeOpenRouter.ts
 *
 * `GET /api/v1/models` does not enumerate embedding or rerank models (see
 * src/lib/openrouter/models.ts), so the curated lists there are hand-
 * maintained and can silently go stale when a provider withdraws a model.
 * `validateModel()` hits `GET /api/v1/models/{id}/endpoints`, which needs NO
 * API key and makes no billable call — safe to run in CI on every push.
 *
 * Exit code is non-zero only when a curated EMBEDDING or RERANK model has
 * gone unavailable — those break ingestion/search outright. A curated CHAT
 * model going unavailable is reported but does not fail the build (chat has
 * 445+ alternatives; embedding/rerank spaces are pinned and cannot swap
 * freely without re-indexing).
 *
 * Two distinct failure reasons, from client.ts's classify():
 *   - 'no-providers'  — model id is valid but nobody currently serves it.
 *                       Transient; still WARNS because embedding/rerank
 *                       spaces have no automatic fallback.
 *   - 'unknown-model' — the id itself is wrong. A real config error.
 */
import {
  OPENROUTER_EMBEDDING_MODELS,
  OPENROUTER_RERANK_MODELS,
  OPENROUTER_CHAT_MODELS,
  allCuratedModelIds,
} from '../src/lib/openrouter/models';
import { validateModel, type ModelAvailability } from '../src/lib/openrouter/client';

type Kind = 'embedding' | 'rerank' | 'chat';

function kindOf(id: string): Kind {
  if (OPENROUTER_EMBEDDING_MODELS.some((m) => m.id === id)) return 'embedding';
  if (OPENROUTER_RERANK_MODELS.some((m) => m.id === id)) return 'rerank';
  return 'chat';
}

function fmtPrice(p: number | undefined): string {
  return p != null ? `$${p.toFixed(3)}/M` : '—';
}

async function main(): Promise<void> {
  const ids = allCuratedModelIds();
  console.log(`Probing ${ids.length} curated OpenRouter models (no API key required)...\n`);

  const rows: Array<{ kind: Kind; result: ModelAvailability }> = [];
  for (const id of ids) {
    const result = await validateModel(id);
    rows.push({ kind: kindOf(id), result });
  }

  const header = ['MODEL', 'KIND', 'AVAILABLE', 'REASON', 'PROVIDERS', 'PRICE'];
  const widths = [40, 10, 10, 14, 30, 10];
  console.log(header.map((h, i) => h.padEnd(widths[i])).join(''));
  console.log('-'.repeat(widths.reduce((a, b) => a + b, 0)));

  let hardFailures = 0;
  let warnings = 0;

  for (const { kind, result } of rows) {
    const line = [
      result.id,
      kind,
      result.available ? 'yes' : 'NO',
      result.reason ?? '—',
      result.providers.join(', ') || '—',
      fmtPrice(result.pricePerMTokens),
    ];
    console.log(line.map((c, i) => String(c).padEnd(widths[i])).join(''));

    if (!result.available) {
      if (kind === 'chat') {
        warnings++;
      } else if (result.reason === 'unknown-model') {
        hardFailures++;
      } else {
        // 'no-providers' on a pinned embedding/rerank space: no automatic
        // fallback exists, so this is CI-fatal too, not just a warning.
        hardFailures++;
      }
    }
  }

  console.log('');
  const chatCount = OPENROUTER_CHAT_MODELS.length;
  const embedCount = OPENROUTER_EMBEDDING_MODELS.length;
  const rerankCount = OPENROUTER_RERANK_MODELS.length;
  console.log(`Checked: ${embedCount} embedding, ${rerankCount} rerank, ${chatCount} chat.`);
  console.log(`Unavailable embedding/rerank models: ${hardFailures}`);
  console.log(`Unavailable chat models (non-fatal): ${warnings}`);

  if (hardFailures > 0) {
    console.error(
      `\nFAIL: ${hardFailures} curated embedding/rerank model(s) are unavailable. ` +
        `Re-probe and update src/lib/openrouter/models.ts before merging.`,
    );
    process.exit(1);
  }

  console.log('\nOK: all curated embedding/rerank models are available.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
