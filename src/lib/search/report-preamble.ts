/**
 * Synthesis-output preamble splitter.
 *
 * A synthesis model handed a very large excerpt block can continue the
 * *document* instead of answering it: it emits more excerpt-shaped text, then
 * reconstructs the instruction block it expected to find at the end of the
 * prompt, then plans out loud, and only then writes the report. All of that
 * arrives on the provider's normal text channel (`text_delta`), so nothing
 * upstream can tell it apart from the answer — it lands in the report, gets
 * persisted, and react-markdown turns the bracketed citation lines into
 * broken headings.
 *
 * This module is the safety net: it detects that shape and splits it off the
 * front of the answer so the report field only ever holds report prose. The
 * split-off text is not discarded — it becomes the turn's "thoughts" trace.
 *
 * The detector is deliberately conservative. It only engages when the leading
 * text carries *positive* evidence of an excerpt echo (standalone bracketed
 * citation lines, which report prose does not produce), so a report that
 * simply opens with a paragraph is never truncated.
 */

/** How much leading text to inspect for echo evidence before giving up and
 *  treating everything as answer. The echo signature shows up within the
 *  first few hundred chars; this bounds the streaming hold-back. */
export const PREAMBLE_SCAN_WINDOW = 900;

/** Hard cap on retained thoughts. Beyond this the trace is truncated — it is
 *  diagnostic material, not something worth persisting without bound. */
export const THOUGHTS_CHAR_CAP = 60000;

/** Lookback held during streaming so a marker straddling two chunks is still
 *  matched before the text ahead of it has been emitted as thoughts. */
const STREAM_LOOKBACK = 512;

/**
 * A standalone bracketed citation line — the shape `buildCiteContext` emits
 * ahead of every excerpt (`[3 RR 184:12]`, `[Case: … | Filing: …]`). Report
 * prose cites inline, mid-sentence, so a bracket occupying a whole line is a
 * reliable tell that raw context is being echoed.
 */
const ECHO_CITE_LINE = /^\[[^\]\n]{3,300}\][ \t]*$/gm;

/** Two of them is the threshold — one could plausibly be stylistic. */
const ECHO_MIN_CITE_LINES = 2;

/**
 * Headings that belong to the prompt scaffolding rather than the report, so a
 * match on them must not be mistaken for the start of the answer.
 */
const SCAFFOLD_HEADINGS =
  /^(instructions|report structure|citation rules|important|document excerpts|initial document excerpts|previous conversation|research question|sub-questions investigated|research intent|active workflow context|your subsection|full report outline)\b/i;

/**
 * The first heading of a real report. `REPORT_SYSTEM_PROMPT` asks for Summary
 * first, so normal output opens `## Summary` or `## 1. Summary`; models often
 * add a `# Research Report: …` title above it. Both must match.
 */
const REPORT_START = /^#{1,3}[ \t]*(?:\*\*)?(?:\d+[.)][ \t]*)?([A-Za-z][^\n]*)$/gm;

function isReportStartHeading(headingText: string): boolean {
  const t = headingText.replace(/\*\*/g, '').trim();
  if (SCAFFOLD_HEADINGS.test(t)) return false;
  return /^(research report|report|executive summary|summary|overview|findings|answer)\b/i.test(t);
}

/** Does the leading window look like echoed retrieval context? */
export function hasEchoEvidence(text: string): boolean {
  const window = text.slice(0, PREAMBLE_SCAN_WINDOW);
  ECHO_CITE_LINE.lastIndex = 0;
  let count = 0;
  while (ECHO_CITE_LINE.exec(window) !== null) {
    count++;
    if (count >= ECHO_MIN_CITE_LINES) return true;
  }
  return false;
}

/** Index where the report proper starts, or -1 if no report heading is present. */
export function findReportStart(text: string, from = 0): number {
  REPORT_START.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = REPORT_START.exec(text)) !== null) {
    if (isReportStartHeading(m[1])) return m.index;
  }
  return -1;
}

export interface PreambleSplit {
  /** Echoed context + out-loud planning that preceded the report. */
  thoughts: string;
  /** The report itself. Empty when the model never got to one. */
  report: string;
}

/**
 * Split a completed synthesis output into thoughts + report.
 *
 * With no echo evidence the text passes through untouched — this must stay
 * true, or a normal report that happens to open with prose would be eaten.
 */
export function splitReportPreamble(text: string): PreambleSplit {
  if (!text || !hasEchoEvidence(text)) return { thoughts: '', report: text };
  const start = findReportStart(text);
  if (start < 0) return { thoughts: capThoughts(text), report: '' };
  return {
    thoughts: capThoughts(text.slice(0, start).trimEnd()),
    report: text.slice(start),
  };
}

export function capThoughts(text: string): string {
  if (text.length <= THOUGHTS_CHAR_CAP) return text;
  return `${text.slice(0, THOUGHTS_CHAR_CAP)}\n\n…[trace truncated at ${THOUGHTS_CHAR_CAP} characters]`;
}

export interface PreambleSplitterHandlers {
  /** Receives report tokens only. */
  onToken?: (text: string) => void;
  /** Receives echoed context / planning text. */
  onThoughts?: (text: string) => void;
}

export interface PreambleSplitter {
  push(chunk: string): void;
  /** Flush whatever is held. Returns the report text seen so far. */
  finish(): PreambleSplit;
}

/**
 * Streaming form of {@link splitReportPreamble}.
 *
 * Holds back at most `PREAMBLE_SCAN_WINDOW` characters while deciding whether
 * the output opens with an echo. Once decided it is a straight pass-through in
 * one direction or the other, so the live token feed stays live.
 */
export function createPreambleSplitter(
  handlers: PreambleSplitterHandlers,
): PreambleSplitter {
  type Mode = 'scanning' | 'diverting' | 'answer';
  let mode: Mode = 'scanning';
  let buffer = '';
  let thoughts = '';
  let thoughtsEmitted = 0;
  let report = '';

  const emitReport = (text: string) => {
    if (!text) return;
    report += text;
    handlers.onToken?.(text);
  };

  const emitThoughts = (text: string) => {
    if (!text) return;
    if (thoughts.length >= THOUGHTS_CHAR_CAP) return;
    thoughts += text;
    handlers.onThoughts?.(text);
  };

  /** In diverting mode, release everything except the lookback tail. */
  const drainThoughts = (upTo: number) => {
    if (upTo <= thoughtsEmitted) return;
    emitThoughts(buffer.slice(thoughtsEmitted, upTo));
    thoughtsEmitted = upTo;
  };

  const trySplit = (final: boolean) => {
    // Only ever evaluate COMPLETE lines. `$` under /m also matches end-of-input,
    // so a buffer cut mid-heading ("## Report Struc") would otherwise be read as
    // a heading named "Report Struc" — which slips past the scaffolding filter
    // and splits the stream in the middle of the prompt echo.
    const lastNewline = buffer.lastIndexOf('\n');
    const searchable = final || lastNewline < 0 ? buffer : buffer.slice(0, lastNewline + 1);
    const start = findReportStart(searchable, thoughtsEmitted);
    if (start < 0) {
      drainThoughts(Math.max(thoughtsEmitted, buffer.length - STREAM_LOOKBACK));
      return;
    }
    drainThoughts(start);
    thoughts = thoughts.trimEnd();
    mode = 'answer';
    const tail = buffer.slice(start);
    buffer = '';
    thoughtsEmitted = 0;
    emitReport(tail);
  };

  return {
    push(chunk: string) {
      if (!chunk) return;
      if (mode === 'answer') {
        emitReport(chunk);
        return;
      }
      buffer += chunk;
      if (mode === 'scanning') {
        if (hasEchoEvidence(buffer)) {
          mode = 'diverting';
        } else if (buffer.length >= PREAMBLE_SCAN_WINDOW) {
          mode = 'answer';
          const held = buffer;
          buffer = '';
          emitReport(held);
          return;
        } else {
          return; // keep holding until we can decide
        }
      }
      trySplit(false);
    },
    finish(): PreambleSplit {
      if (mode === 'scanning') {
        // Never saw enough text to find echo evidence — it's all answer.
        const held = buffer;
        buffer = '';
        mode = 'answer';
        emitReport(held);
      } else if (mode === 'diverting') {
        // Last chance for a report heading sitting on the final, unterminated line.
        trySplit(true);
      }
      if (mode === 'diverting') {
        drainThoughts(buffer.length);
        thoughts = thoughts.trimEnd();
        buffer = '';
      }
      return { thoughts, report };
    },
  };
}
