'use client';

import { useCallback, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import type { TagSpec } from './tag-spec';
import {
  canonicalizeTagValue,
  parseClipboardForSpec,
  clipboardSupport,
} from './tag-clipboard';

/**
 * Per-tag-row copy + paste icon affordance. Renders inside a `group`
 * container so the buttons fade in only on hover/focus — they don't clutter
 * the tag panel at rest.
 *
 * Copy: writes `canonicalizeTagValue(spec, value)` to the clipboard. For
 * refs that's the bare UUID, not the display name. Flashes a checkmark for
 * ~1.5 s on success.
 *
 * Paste: reads from clipboard, runs `parseClipboardForSpec`, and calls
 * `onPaste` with the normalized value. Caller routes that through the same
 * commitEntity path the inline edit affordance uses.
 */
export function TagRowActions({
  spec,
  value,
  onPaste,
  editMode,
}: {
  spec: TagSpec;
  value: unknown;
  onPaste: (next: unknown) => void;
  /** When false, paste icon is hidden (read-mode and not editable). */
  editMode: boolean;
}) {
  const { copy: supportsCopy, paste: supportsPaste } = clipboardSupport(spec);
  const [copied, setCopied] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  const canonical = canonicalizeTagValue(spec, value);

  const handleCopy = useCallback(() => {
    if (!canonical) return;
    navigator.clipboard.writeText(canonical).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard write rejected (permissions) — silent */
      },
    );
  }, [canonical]);

  const handlePaste = useCallback(async () => {
    setPasteError(null);
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setPasteError('Clipboard unavailable');
      setTimeout(() => setPasteError(null), 2000);
      return;
    }
    const parsed = parseClipboardForSpec(spec, text);
    if (parsed.error) {
      setPasteError(parsed.error);
      setTimeout(() => setPasteError(null), 2500);
      return;
    }
    onPaste(parsed.value);
  }, [spec, onPaste]);

  if (!supportsCopy && !supportsPaste) return null;

  const tooltipFieldLabel =
    spec.valueType === 'ref'
      ? `Copy ${spec.name} UUID`
      : spec.valueType === 'date'
        ? `Copy ${spec.name} (ISO date)`
        : `Copy ${spec.name} value`;

  // The wrapping span uses `opacity-0 group-hover:opacity-100` so the row's
  // hover state (the parent .group element provided by the row component)
  // gates visibility. Buttons are still focusable via keyboard → showing
  // on focus-within keeps them reachable for keyboard users.
  return (
    <span className="inline-flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex-shrink-0">
      {supportsCopy && Boolean(canonical) && (
        <IconButton
          tooltip={copied ? 'Copied!' : tooltipFieldLabel}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            handleCopy();
          }}
          className="p-0.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
        >
          {copied ? (
            <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </IconButton>
      )}
      {supportsPaste && editMode && (
        <IconButton
          tooltip={pasteError || 'Paste value from clipboard'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void handlePaste();
          }}
          className={`p-0.5 rounded transition-colors ${
            pasteError
              ? 'text-red-500 hover:bg-red-50'
              : 'text-gray-400 hover:text-blue-600 hover:bg-blue-50'
          }`}
        >
          {/* clipboard-with-arrow icon */}
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </IconButton>
      )}
    </span>
  );
}
