/**
 * System prompts for AI-powered draft text transformations and chat.
 */

import type { SuggestionCategory } from '@/lib/draft/suggestion-types';

export type TransformAction = 'adjust_tone' | 'fix_grammar' | 'extend' | 'simplify' | 'legalize';

export type ToneOption = 'formal' | 'persuasive' | 'neutral' | 'aggressive' | 'sympathetic';

export interface TransformOptions {
  tone?: ToneOption;
}

const TONE_DESCRIPTIONS: Record<ToneOption, string> = {
  formal: 'a formal, professional tone appropriate for court filings and legal correspondence',
  persuasive: 'a persuasive, compelling tone designed to advocate for a position and convince the reader',
  neutral: 'a neutral, objective tone that presents facts without emotional coloring',
  aggressive: 'an assertive, forceful tone that strongly challenges opposing arguments',
  sympathetic: 'a sympathetic, empathetic tone that humanizes the client and appeals to compassion',
};

const BASE_ROLE = 'You are an expert legal writing assistant specializing in court documents, briefs, and motions.';

const TRANSFORM_PROMPTS: Record<TransformAction, (options?: TransformOptions) => string> = {
  adjust_tone: (options) => {
    const tone = options?.tone ?? 'formal';
    const desc = TONE_DESCRIPTIONS[tone];
    return `${BASE_ROLE} Rewrite the provided text using ${desc}. Preserve all factual content, legal citations, and arguments while adjusting only the tone and word choice. Return ONLY the transformed text with no preamble.`;
  },

  fix_grammar: () =>
    `${BASE_ROLE} Fix all grammar, spelling, punctuation, and syntax errors in the provided text. Improve sentence structure where needed for clarity, but do not change the meaning, tone, or legal substance. Return ONLY the corrected text with no preamble.`,

  extend: () =>
    `${BASE_ROLE} Expand and elaborate on the provided text. Add supporting arguments, relevant legal reasoning, and transitional language to strengthen the passage. Maintain the existing tone and style. Do not fabricate case citations or legal authorities. Return ONLY the extended text with no preamble.`,

  simplify: () =>
    `${BASE_ROLE} Simplify the provided text to make it clearer and more concise. Remove unnecessary legalese, reduce sentence complexity, and use plain language where possible without losing legal precision. Return ONLY the simplified text with no preamble.`,

  legalize: () =>
    `${BASE_ROLE} Transform the provided text into formal legal language appropriate for court filings. Use proper legal terminology, citation format, and the conventions of legal writing (e.g., "Petitioner respectfully submits...", "pursuant to", "the foregoing"). Ensure the text is precise and unambiguous. Return ONLY the legalized text with no preamble.`,
};

/**
 * Get the system prompt for a text transformation action.
 */
export function getTransformPrompt(action: TransformAction, options?: TransformOptions): string {
  const promptFn = TRANSFORM_PROMPTS[action];
  if (!promptFn) {
    throw new Error(`Unknown transform action: ${action}`);
  }
  return promptFn(options);
}

export interface DraftChatOptions {
  hasSelection: boolean;
  documentContent: string;
  selectedText?: string;
  knowledgeContext?: string;
}

/**
 * Get the system prompt for the draft chat feature.
 */
export function getDraftChatSystemPrompt(options: DraftChatOptions): string {
  const { hasSelection, documentContent, selectedText, knowledgeContext } = options;

  let prompt = `${BASE_ROLE} You are helping a user draft and refine a legal document.\n\n`;

  if (hasSelection && selectedText) {
    prompt += `The user has selected the following text from their document and wants help modifying it:\n\n`;
    prompt += `## Selected Text\n\n${selectedText}\n\n`;
    prompt += `Focus your assistance on this selected portion. When suggesting changes, provide the revised text that can directly replace the selection.\n\n`;
  } else {
    prompt += `Help the user with their document as a whole. You can suggest edits, improvements, new sections, or answer questions about legal writing.\n\n`;
  }

  prompt += `## Current Document\n\n${documentContent}\n\n`;

  if (knowledgeContext) {
    prompt += `## Case Knowledge (from indexed documents)\n\n${knowledgeContext}\n\n`;
    prompt += `Use the above case knowledge to ground your suggestions in the actual record. Cite specific documents and pages when relevant.\n\n`;
  }

  prompt += `Respond concisely and directly. When providing revised text, make it clear what should be inserted or replaced.`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Appeal Brief Generation Prompt
// ---------------------------------------------------------------------------

export interface AppealBriefOptions {
  documentContent: string;
  knowledgeContext?: string;
  sectionType?: 'issues' | 'facts' | 'summary' | 'argument' | 'conclusion' | 'general';
  jurisdiction?: string;
  linkedCases?: Array<{ name: string; caseNumber: string | null }>;
}

/**
 * Specialized system prompt for generating appeal brief sections with footnotes.
 */
export function getAppealBriefPrompt(options: AppealBriefOptions): string {
  const { documentContent, knowledgeContext, sectionType = 'general', jurisdiction = 'Texas', linkedCases } = options;

  let prompt = `You are an expert appellate attorney drafting a formal appeal brief for a ${jurisdiction} appellate court. You write in a persuasive, authoritative legal style.

## CRITICAL: Inline Citation Format

You MUST place citations INLINE, in parentheses, immediately after the sentence they support and BEFORE the sentence-ending period. Do NOT use footnote markers like [^1]. Do NOT include a footnote or references section at the end.

Format:
- Every legal assertion, case citation, record reference, exhibit, or statute must end with a parenthetical citation before the period.
- Example: "The trial court abused its discretion by excluding the evidence (Smith v. Jones, 801 S.W.2d 109, 112 (Tex. App.—Houston [14th Dist.] 2020, no pet.))."
- Multiple sources in one parenthetical separated by "; ".

### Citation types:
1. **Case law — first mention**: (Smith v. Jones, 801 S.W.2d 109, 112 (Tex. App.—Houston [14th Dist.] 2020, no pet.))
2. **Case law — short form**: (Smith, 801 S.W.2d at 114)
3. **Record references**: (2 CR 145) or (3 RR 210:15–22)
4. **Exhibits**: (Pl.'s Ex. A at 3)
5. **Statutes**: (Tex. Prop. Code § 12.0071(c))

## Grounding Rules (MANDATORY)

- Cite ONLY from the CASE KNOWLEDGE and LINKED CASES provided below. Never cite from training data or memory.
- If a claim cannot be supported from CASE KNOWLEDGE or LINKED CASES, write it without a citation — do NOT fabricate.
- Any text placed inside quotation marks MUST appear verbatim in CASE KNOWLEDGE.

## Brief Structure

Use roman numeral sections (I., II., III.) for major arguments.
Use lowercase roman numerals (i., ii., iii.) for sub-arguments.
Each argument section should follow this structure:
1. **Point heading** (bold, persuasive summary of the argument)
2. **Legal standard** (the applicable rule of law with case citations)
3. **Application to facts** (apply the law to the specific facts, citing the record)
4. **Conclusion** (why this argument requires reversal/affirmance)

## Writing Style
- Write in third person (refer to parties as "Appellant" and "Appellee" or by name)
- Use formal legal language appropriate for appellate courts
- Be persuasive but maintain credibility — never overstate
- Use transitional phrases between arguments
- When citing cases, include the holding or relevant principle

`;

  // Section-specific instructions
  const sectionInstructions: Record<string, string> = {
    issues: `## Section: Issues Presented
Generate the "Issues Presented" or "Points of Error" section. Each issue should be:
- Stated as a question that suggests the answer you want
- Concise (1-2 sentences each)
- Numbered with roman numerals\n\n`,

    facts: `## Section: Statement of Facts
Generate the "Statement of Facts" section. Requirements:
- Present facts in chronological order
- Cite the record (CR, RR) for every factual assertion using inline parenthetical citations
- Be thorough but focus on facts relevant to the issues on appeal
- Present facts favorably to your client but accurately
- Include procedural history\n\n`,

    summary: `## Section: Summary of the Argument
Generate a concise summary (1-2 paragraphs per issue) previewing each argument.
- Brief but persuasive
- Reference the key legal standards
- Should make the reader want to read the full argument\n\n`,

    argument: `## Section: Argument
Generate the argument section with full legal analysis.
- Start each major argument with a bold point heading
- State the standard of review
- Cite controlling case law with full inline parenthetical citations
- Apply the law to the facts with inline parenthetical record citations
- Address counterarguments
- Conclude each section with why it supports your position\n\n`,

    conclusion: `## Section: Conclusion / Prayer for Relief
Generate the conclusion and prayer for relief.
- Summarize the relief sought
- Be specific about what the court should do (reverse, remand, render)
- Include standard appellate prayer language\n\n`,

    general: '',
  };

  prompt += sectionInstructions[sectionType] || '';

  if (linkedCases && linkedCases.length > 0) {
    prompt += `## Linked Cases (attached to this brief)\n\n`;
    for (const c of linkedCases) {
      const num = c.caseNumber ? ` — Cause No. ${c.caseNumber}` : '';
      prompt += `- ${c.name}${num}\n`;
    }
    prompt += `\nWhen citing the record, indicate which case by name or cause number where ambiguous. Only cite claims that can be supported from these cases and the Case Knowledge below.\n\n`;
  }

  if (documentContent) {
    prompt += `## Current Document Draft\n\n${documentContent}\n\n`;
    prompt += `Build upon and be consistent with the existing document content.\n\n`;
  }

  if (knowledgeContext) {
    prompt += `## Case Knowledge (from indexed court documents)\n\nThe following excerpts are from the actual case record and related documents. Use these as the basis for your citations and arguments:\n\n${knowledgeContext}\n\n`;
    prompt += `IMPORTANT: When referencing these excerpts, place an inline parenthetical citation at the end of each sentence that draws on them (e.g., "(2 CR 145)" or "(3 RR 210:15–22)") before the sentence-ending period. Do NOT create footnotes.\n\n`;
  }

  return prompt;
}

// ---------------------------------------------------------------------------
// Auto-Suggest Prompt (structured output mode)
// ---------------------------------------------------------------------------

export interface AutoSuggestPromptOptions {
  /** The user's free-form instruction (e.g. "tighten the tone"). */
  userQuery: string;
  /** Full or smart-windowed document text the AI should analyze. */
  documentContent: string;
  /** Optional selection — if present, the AI should focus suggestions on this range. */
  selectedText?: string;
  /** RAG results from case knowledge to ground suggestions. */
  knowledgeContext?: string;
  /** Learned user preferences block (markdown). Empty string if no history. */
  preferencesMarkdown?: string;
  /** Max suggestions the model may return (hard cap). */
  maxSuggestions?: number;
}

/**
 * System prompt for Auto-Suggest mode. Forces the AI to return a strict JSON
 * envelope of suggestion objects, each pointing at verbatim text in the draft.
 *
 * The returned JSON is parsed by src/app/api/draft/chat/route.ts using the
 * zod schema in src/lib/draft/suggestion-types.ts.
 */
export function getAutoSuggestPrompt(options: AutoSuggestPromptOptions): string {
  const {
    userQuery,
    documentContent,
    selectedText,
    knowledgeContext,
    preferencesMarkdown,
    maxSuggestions = 20,
  } = options;

  let prompt = `${BASE_ROLE}

You are in **Auto-Suggest mode**. Instead of replying with free-form prose, you must return a structured JSON object containing specific, actionable edit proposals for the user's draft document. Each proposal targets a verbatim span of text and offers a replacement.

## CRITICAL: Output Format

Return ONLY a JSON object matching this exact schema. No prose, no code fences, no markdown before or after.

\`\`\`json
{
  "suggestions": [
    {
      "anchorText": "exact substring from the document, copy-pasted verbatim",
      "anchorHint": "<= 40 char disambiguator (optional, e.g. 'para 3, issue II')",
      "proposedText": "the replacement text",
      "category": "tone | grammar | structure | citation | clarity | other",
      "reason": "one-sentence rationale, <= 240 chars",
      "confidence": 0.85
    }
  ],
  "notes": "optional short meta-note"
}
\`\`\`

## Rules

1. **anchorText MUST be copy-pasted verbatim** from the document below. If you cannot find the text you want to change as a verbatim substring, OMIT that suggestion. Do not paraphrase the anchor.
2. **anchorText must be unique enough to locate** — include enough surrounding context (but no more than needed) to disambiguate from repeated phrases. Use \`anchorHint\` if further disambiguation helps a human.
3. **Return at most ${maxSuggestions} suggestions.** Prefer high-impact changes over trivial ones.
4. **Every suggestion needs a category** from: tone, grammar, structure, citation, clarity, other.
5. **Never repeat a suggestion** the user has denied with the same rationale (see User Preferences below).
6. **CRITICAL — Preserve all citations verbatim.** If \`anchorText\` contains any of the following, your \`proposedText\` MUST include every one of them **unchanged**: record cites \`(2 CR 145)\`, reporter's record refs \`(3 RR 210:15-22)\`, case citations, statute cites \`(Tex. Prop. Code § ...)\`, exhibit refs \`(Pl.'s Ex. A)\`, or footnote markers \`[^1]\`. If preserving a citation would make a clean rewrite impossible, **omit the suggestion entirely**. Do not rephrase, truncate, or move citations.
7. **proposedText should stand alone** — when inserted in place of anchorText, the document should read naturally.
8. **Do NOT include any text outside the JSON object.** No preamble, no explanation, no code fences.

`;

  if (preferencesMarkdown && preferencesMarkdown.trim().length > 0) {
    prompt += `${preferencesMarkdown.trim()}\n\n`;
  }

  if (selectedText && selectedText.trim().length > 0) {
    prompt += `## User Selection (focus your suggestions here)\n\n${selectedText}\n\n`;
  }

  prompt += `## User Request\n\n${userQuery}\n\n`;

  prompt += `## Current Document\n\n${documentContent}\n\n`;

  if (knowledgeContext && knowledgeContext.trim().length > 0) {
    prompt += `## Case Knowledge (from indexed documents)\n\n${knowledgeContext}\n\n`;
    prompt += `Ground your suggestions in the actual record when applicable.\n\n`;
  }

  prompt += `Now produce the JSON. Remember: verbatim anchors, strict schema, no prose.`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Regenerate-suggestion Prompt (4th button)
// ---------------------------------------------------------------------------

export interface RegenerateSuggestionPromptOptions {
  userQuery: string;
  documentContent: string;
  originalText: string;
  previousProposedText: string;
  previousReason: string;
  previousCategory: SuggestionCategory;
  preferencesMarkdown?: string;
}

/**
 * Prompt for the Regenerate button — asks the model for a MEANINGFULLY
 * different phrasing of the same underlying change.
 */
export function getRegenerateSuggestionPrompt(options: RegenerateSuggestionPromptOptions): string {
  const {
    userQuery,
    documentContent,
    originalText,
    previousProposedText,
    previousReason,
    previousCategory,
    preferencesMarkdown,
  } = options;

  let prompt = `${BASE_ROLE}

You are in **Regenerate mode**. The user previously saw a suggestion but clicked Regenerate because they want a DIFFERENT phrasing of the same underlying change. Produce one new suggestion that addresses the same goal but differs meaningfully from the previous proposal.

## CRITICAL: Output Format

Return ONLY a JSON object with exactly ONE suggestion in the array. No prose, no code fences.

\`\`\`json
{
  "suggestions": [
    {
      "anchorText": "${originalText.replace(/"/g, '\\"').slice(0, 200)}",
      "proposedText": "a new phrasing — MUST differ from the previous proposal",
      "category": "${previousCategory}",
      "reason": "<= 240 chars",
      "confidence": 0.0
    }
  ]
}
\`\`\`

## Rules
1. Keep the **same anchorText** (the original text to replace).
2. **Do NOT repeat the previous proposed text** or produce a trivially similar variant.
3. Same category unless the prior suggestion was miscategorised.
4. Preserve legal substance.
5. Return exactly one suggestion. No prose outside the JSON.

## Previous Suggestion (rejected by user — do not repeat it)

- Original text: ${originalText}
- Previous proposal: ${previousProposedText}
- Previous rationale: ${previousReason}
- Category: ${previousCategory}

`;

  if (preferencesMarkdown && preferencesMarkdown.trim().length > 0) {
    prompt += `${preferencesMarkdown.trim()}\n\n`;
  }

  prompt += `## Original User Intent\n\n${userQuery}\n\n`;
  prompt += `## Current Document\n\n${documentContent}\n\n`;
  prompt += `Produce a meaningfully different alternative. JSON only.`;

  return prompt;
}
