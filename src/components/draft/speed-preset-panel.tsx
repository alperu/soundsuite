'use client';

/**
 * SpeedPresetModal — a modal dialog for configuring Auto-Suggest speed.
 *
 * Top section: three preset cards (Simple / Medium / Ultra) for one-click config.
 * Bottom section: manual override sliders for doc window, max suggestions, token budget.
 * When any override differs from the selected preset, the card shows a "Modified" badge.
 * The estimated time range at the bottom updates live as inputs change.
 */

import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// Types & config
// ---------------------------------------------------------------------------

export type SpeedPreset = 'simple' | 'medium' | 'ultra';

export interface SpeedSettings {
  preset: SpeedPreset | 'custom';
  docWindow: number;       // chars
  maxSuggestions: number;  // 1–30
  maxTokens: number;
}

interface PresetDef {
  docWindow: number;
  maxSuggestions: number;
  maxTokens: number;
  base: [number, number];
  deepAdd: [number, number];
  thinkAdd: [number, number];
  color: string;           // Tailwind color name (e.g. 'emerald')
  description: string;
}

export const SPEED_PRESETS: Record<SpeedPreset, PresetDef> = {
  simple: {
    docWindow: 8_000,
    maxSuggestions: 6,
    maxTokens: 1_024,
    base: [15, 25],
    deepAdd: [10, 20],
    thinkAdd: [5, 10],
    color: 'emerald',
    description: 'Quick pass, small context',
  },
  medium: {
    docWindow: 15_000,
    maxSuggestions: 10,
    maxTokens: 2_048,
    base: [30, 55],
    deepAdd: [30, 60],
    thinkAdd: [10, 20],
    color: 'blue',
    description: 'Balanced speed and quality',
  },
  ultra: {
    docWindow: 30_000,
    maxSuggestions: 16,
    maxTokens: 4_096,
    base: [60, 100],
    deepAdd: [60, 120],
    thinkAdd: [20, 40],
    color: 'purple',
    description: 'Full context, max quality',
  },
};

const DOC_WINDOW_QUICK: number[] = [5_000, 8_000, 15_000, 20_000, 30_000, 50_000];
const TOKEN_QUICK: number[] = [512, 1_024, 2_048, 4_096, 8_192, 16_384];

function fmtWindow(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

function fmtTokens(n: number): string {
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return String(n);
}

/**
 * Compute an estimated time range for the given settings + toggle states.
 * For custom values we pick the nearest preset as a base.
 */
export function estimateRange(settings: SpeedSettings, deep: boolean, think: boolean): string {
  let base: [number, number];
  let deepAdd: [number, number];
  let thinkAdd: [number, number];

  if (settings.preset !== 'custom') {
    const p = SPEED_PRESETS[settings.preset];
    base = p.base;
    deepAdd = p.deepAdd;
    thinkAdd = p.thinkAdd;
  } else {
    // Interpolate based on doc window size
    if (settings.docWindow <= 10_000) {
      base = [15, 30]; deepAdd = [10, 25]; thinkAdd = [5, 12];
    } else if (settings.docWindow <= 20_000) {
      base = [30, 60]; deepAdd = [30, 70]; thinkAdd = [10, 25];
    } else {
      base = [55, 110]; deepAdd = [55, 130]; thinkAdd = [18, 45];
    }
  }

  let [lo, hi] = base;
  if (deep)  { lo += deepAdd[0];  hi += deepAdd[1]; }
  if (think) { lo += thinkAdd[0]; hi += thinkAdd[1]; }
  return `~${lo}–${hi}s`;
}

function isPresetMatch(s: SpeedSettings, key: SpeedPreset): boolean {
  const p = SPEED_PRESETS[key];
  return s.docWindow === p.docWindow && s.maxSuggestions === p.maxSuggestions && s.maxTokens === p.maxTokens;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface SpeedPresetModalProps {
  current: SpeedSettings;
  deepSearch: boolean;
  thinkingMode: boolean;
  onApply: (settings: SpeedSettings) => void;
  onClose: () => void;
}

export function SpeedPresetModal({
  current,
  deepSearch,
  thinkingMode,
  onApply,
  onClose,
}: SpeedPresetModalProps) {
  // Local draft state — committed only on Apply
  const [docWindow, setDocWindow] = useState(current.docWindow);
  const [maxSuggestions, setMaxSuggestions] = useState(current.maxSuggestions);
  const [maxTokens, setMaxTokens] = useState(current.maxTokens);

  // Derive the effective preset label from the current draft values
  const effectivePreset: SpeedPreset | 'custom' =
    (Object.keys(SPEED_PRESETS) as SpeedPreset[]).find((k) =>
      isPresetMatch({ preset: k, docWindow, maxSuggestions, maxTokens }, k)
    ) ?? 'custom';

  // Dismiss on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const draftSettings: SpeedSettings = { preset: effectivePreset, docWindow, maxSuggestions, maxTokens };

  const handleApply = () => onApply(draftSettings);

  const applyPreset = (key: SpeedPreset) => {
    const p = SPEED_PRESETS[key];
    setDocWindow(p.docWindow);
    setMaxSuggestions(p.maxSuggestions);
    setMaxTokens(p.maxTokens);
  };

  const PRESET_KEYS: SpeedPreset[] = ['simple', 'medium', 'ultra'];

  const CARD_CLASSES: Record<SpeedPreset, { border: string; bg: string; badge: string; pill: string }> = {
    simple: {
      border: 'border-emerald-400',
      bg: 'bg-emerald-50',
      badge: 'text-emerald-700',
      pill: 'bg-emerald-100 text-emerald-700',
    },
    medium: {
      border: 'border-blue-400',
      bg: 'bg-blue-50',
      badge: 'text-blue-700',
      pill: 'bg-blue-100 text-blue-700',
    },
    ultra: {
      border: 'border-purple-400',
      bg: 'bg-purple-50',
      badge: 'text-purple-700',
      pill: 'bg-purple-100 text-purple-700',
    },
  };

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[1px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Modal card */}
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl border border-gray-200 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="text-sm font-semibold text-gray-800">Search Speed Settings</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Preset cards */}
          <div className="grid grid-cols-3 gap-2.5">
            {PRESET_KEYS.map((key) => {
              const p = SPEED_PRESETS[key];
              const cls = CARD_CLASSES[key];
              const isActive = effectivePreset === key;
              const estimate = estimateRange({ preset: key, docWindow: p.docWindow, maxSuggestions: p.maxSuggestions, maxTokens: p.maxTokens }, deepSearch, thinkingMode);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  className={`rounded-lg border-2 p-2.5 text-left transition-all cursor-pointer ${isActive ? `${cls.border} ${cls.bg}` : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'}`}
                >
                  <div className={`text-[11px] font-bold uppercase tracking-wide mb-1 ${isActive ? cls.badge : 'text-gray-700'}`}>
                    {key.charAt(0).toUpperCase() + key.slice(1)}
                  </div>
                  <div className={`text-[11px] font-semibold rounded px-1.5 py-0.5 inline-block mb-1.5 ${isActive ? cls.pill : 'bg-gray-100 text-gray-600'}`}>
                    {estimate}
                  </div>
                  <div className="text-[10px] text-gray-500 leading-snug">
                    {fmtWindow(p.docWindow)} · {p.maxSuggestions} sugg · {fmtTokens(p.maxTokens)}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-0.5">{p.description}</div>
                </button>
              );
            })}
          </div>

          {effectivePreset === 'custom' && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
              Custom settings — time estimates are approximate.
            </div>
          )}

          {/* Override section */}
          <div className="space-y-4">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Override</div>

            {/* Document window */}
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1.5">
                Document window
                <span className="ml-1 text-gray-400 font-normal">— how much of your document the AI sees</span>
              </label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {DOC_WINDOW_QUICK.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDocWindow(v)}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium border transition-colors ${docWindow === v ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'}`}
                  >
                    {fmtWindow(v)}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1000}
                  max={200_000}
                  step={1000}
                  value={docWindow}
                  onChange={(e) => setDocWindow(Math.max(1000, Math.min(200_000, Number(e.target.value))))}
                  className="w-28 rounded border border-gray-300 px-2 py-1 text-[12px] text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                />
                <span className="text-[11px] text-gray-400">chars</span>
              </div>
            </div>

            {/* Max suggestions */}
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1.5">
                Max suggestions
                <span className="ml-2 text-[12px] font-semibold text-gray-800">{maxSuggestions}</span>
              </label>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-gray-400 w-4 text-right">1</span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={maxSuggestions}
                  onChange={(e) => setMaxSuggestions(Number(e.target.value))}
                  className="flex-1 accent-purple-600"
                />
                <span className="text-[10px] text-gray-400 w-5">30</span>
              </div>
            </div>

            {/* Token budget */}
            <div>
              <label className="block text-[12px] font-medium text-gray-700 mb-1.5">Token budget</label>
              <div className="flex flex-wrap gap-1.5">
                {TOKEN_QUICK.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMaxTokens(v)}
                    className={`rounded px-2 py-0.5 text-[11px] font-medium border transition-colors ${maxTokens === v ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-500'}`}
                  >
                    {fmtTokens(v)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Estimate row */}
          <div className="rounded-lg bg-gray-50 border border-gray-200 px-3.5 py-2.5 flex items-center justify-between gap-3">
            <div>
              <div className="text-[11px] text-gray-500 mb-0.5">
                Estimated time
                {(deepSearch || thinkingMode) && (
                  <span className="ml-1 text-gray-400">
                    ({[deepSearch && 'Deep', thinkingMode && 'Thinking'].filter(Boolean).join(' + ')} ON)
                  </span>
                )}
              </div>
              <div className="text-[15px] font-bold text-gray-800">
                {estimateRange(draftSettings, deepSearch, thinkingMode)}
              </div>
            </div>
            <div className="text-right text-[10px] text-gray-400 leading-relaxed">
              Window: {fmtWindow(docWindow)}<br />
              Suggestions: {maxSuggestions}<br />
              Tokens: {fmtTokens(maxTokens)}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2.5 px-5 py-3 border-t border-gray-200 bg-gray-50">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-4 py-1.5 text-[12px] font-medium text-gray-600 border border-gray-300 bg-white hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="rounded-md px-4 py-1.5 text-[12px] font-semibold text-white bg-purple-600 hover:bg-purple-700 transition-colors"
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
