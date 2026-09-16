/**
 * @jest-environment node
 *
 * Replays a REAL rejected OCR output through the quality gate.
 *
 * Why this exists: the synthetic fixtures in ocr-quality-gate.test.ts cover
 * the clean-prefix shape (good text, then a repeated line) but three attempts
 * failed to reproduce the shape that actually matters — a page of ~1,079
 * short lines, 13,773 characters, condemned by the 24-character shingle check
 * while every line looks novel line-by-line. `cutAtNoveltyCollapse` was
 * written for that shape and had nothing exercising it.
 *
 * The reason synthesis kept failing is structural: `shingleRatioLow` walks
 * NON-OVERLAPPING 24-char windows across the whole text, so a repeating unit
 * only collapses the ratio when its period aligns with that grid. Short
 * non-dictionary tokens trip 'letter-soup' instead; distinct dictionary lines
 * pass cleanly. Only the real output has the real alignment.
 *
 * PRIVACY — read before running this:
 *
 * A captured output is verbatim OCR of a real litigation page: party names,
 * account numbers, form data. It MUST NOT be committed, quoted in a commit
 * message, or pasted into docs. This test therefore takes the file path from
 * an env var and skips when unset, which is exactly the pattern CLAUDE.md
 * requires for tests needing a real PDF. Nothing here asserts on content —
 * only on shape and on the gate's verdict — so a failure message cannot leak
 * the page either.
 *
 * To produce one:
 *   mkdir -p data/ocr-captures          # the switch; /data is gitignored
 *   …run a repair over a dense page…    # e.g. Fix Partial on an RR volume
 *   OCR_REJECT_FIXTURE=data/ocr-captures/<stamp>_ocr_repetition-loop.txt \
 *     npx jest ocr-quality-gate-real-reject
 *   rmdir data/ocr-captures             # turn capture back off
 */

import * as fs from 'fs';
import { assessOcrOutput, salvageRepetitionLoop } from '../ocr-quality-gate';

const FIXTURE = process.env.OCR_REJECT_FIXTURE;
const describeIfFixture = FIXTURE ? describe : describe.skip;

describeIfFixture('a real rejected OCR output', () => {
  let text = '';

  beforeAll(() => {
    text = fs.readFileSync(FIXTURE!, 'utf8');
  });

  it('is still rejected by the gate — the capture is of a genuine failure', () => {
    const assessment = assessOcrOutput(text);
    // Shape only. Never log the text itself.
    // eslint-disable-next-line no-console
    console.log('[real-reject] chars=%d lines=%d reasons=%s declined=%s',
      text.length,
      text.split('\n').length,
      JSON.stringify(assessment.reasons),
      JSON.stringify(assessment.salvageDeclined ?? null));
    expect(assessment.ok).toBe(false);
  });

  it('either salvages a prefix the gate accepts, or declines with a reason', () => {
    const assessment = assessOcrOutput(text);

    if (assessment.salvagedText) {
      // The safety property, on real data: whatever is kept must pass every
      // check on its own, or salvage is a hole in the gate rather than a use
      // of it.
      expect(assessOcrOutput(assessment.salvagedText).ok).toBe(true);
      // And it must be a genuine prefix of the original, not a rewrite.
      expect(text.startsWith(assessment.salvagedText.slice(0, 200))).toBe(true);
      // Salvaging nearly everything would mean the cut did nothing useful —
      // that is the bug the first implementation had (2,571 chars kept from a
      // 663-char page's worth of real text).
      expect(assessment.salvagedText.length).toBeLessThan(text.length);
      // eslint-disable-next-line no-console
      console.log('[real-reject] SALVAGED %d of %d chars (%d%%)',
        assessment.salvagedText.length, text.length,
        Math.round((assessment.salvagedText.length / text.length) * 100));
    } else {
      // A decline is an acceptable outcome, but it must say why: a silent
      // no-op is what made this feature unfalsifiable the first time.
      expect(assessment.salvageDeclined ?? assessment.reasons.join(',')).toBeTruthy();
    }
  });

  it('never returns text the gate would reject, whichever strategy wins', () => {
    const outcome = salvageRepetitionLoop(text);
    if ('text' in outcome) {
      expect(assessOcrOutput(outcome.text).ok).toBe(true);
      expect(outcome.text.length).toBeGreaterThanOrEqual(400);
    } else {
      expect(outcome.declined).toBeTruthy();
    }
  });
});

// Keep the suite honest when no fixture is provided: a skipped describe with
// no other test reads as "0 tests" and looks like a broken file.
describe('the real-reject replay harness', () => {
  it(FIXTURE ? 'is running against a captured fixture' : 'skips without OCR_REJECT_FIXTURE', () => {
    expect(typeof FIXTURE === 'string' || FIXTURE === undefined).toBe(true);
  });
});
