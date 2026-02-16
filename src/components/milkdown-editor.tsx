'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { replaceAll } from '@milkdown/kit/utils';
import type { Crepe as CrepeType } from '@milkdown/crepe';

// Crepe theme CSS — loaded statically so Turbopack can bundle them
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

interface MilkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  readOnly?: boolean;
}

export default function MilkdownEditor({ value, onChange, readOnly }: MilkdownEditorProps) {
  const editorDivRef = useRef<HTMLDivElement>(null);
  const crepeRef = useRef<CrepeType | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [ready, setReady] = useState(false);
  const [viewMode, setViewMode] = useState<'rich' | 'source'>('rich');

  // Initialize Crepe editor
  useEffect(() => {
    if (!editorDivRef.current) return;

    let destroyed = false;
    let crepeInstance: CrepeType | null = null;

    (async () => {
      const { Crepe } = await import('@milkdown/crepe');

      if (destroyed) return;

      crepeInstance = new Crepe({
        root: editorDivRef.current!,
        defaultValue: value,
        features: {
          [Crepe.Feature.Toolbar]: true,
          [Crepe.Feature.BlockEdit]: true,
          [Crepe.Feature.Placeholder]: true,
          [Crepe.Feature.LinkTooltip]: true,
          [Crepe.Feature.ListItem]: true,
          [Crepe.Feature.ImageBlock]: true,
          [Crepe.Feature.Cursor]: true,
          [Crepe.Feature.Table]: true,
          [Crepe.Feature.CodeMirror]: true,
          [Crepe.Feature.Latex]: false,
        },
        featureConfigs: {
          [Crepe.Feature.Placeholder]: {
            text: 'Start writing...',
          },
        },
      });

      // Listen for markdown changes from the rich editor
      crepeInstance.on((listener) => {
        listener.markdownUpdated((_ctx, markdown, prevMarkdown) => {
          if (markdown !== prevMarkdown) {
            onChangeRef.current(markdown);
          }
        });
      });

      await crepeInstance.create();
      crepeRef.current = crepeInstance;

      if (readOnly) {
        crepeInstance.setReadonly(true);
      }

      setReady(true);
    })();

    return () => {
      destroyed = true;
      if (crepeInstance) {
        crepeInstance.destroy().catch(() => {});
        crepeRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle read-only toggle
  useEffect(() => {
    if (crepeRef.current && ready) {
      crepeRef.current.setReadonly(!!readOnly);
    }
  }, [readOnly, ready]);

  // Switch to source mode: serialize Crepe state → textarea
  const switchToSource = useCallback(() => {
    if (crepeRef.current) {
      const markdown = crepeRef.current.getMarkdown();
      if (textareaRef.current) {
        textareaRef.current.value = markdown;
      }
    }
    setViewMode('source');
    // Focus textarea after render
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
    });
  }, []);

  // Switch to rich mode: read textarea → push to Crepe
  const switchToRich = useCallback(() => {
    if (textareaRef.current && crepeRef.current) {
      const markdown = textareaRef.current.value;
      try {
        crepeRef.current.editor.action(replaceAll(markdown));
      } catch {
        // Editor may not be ready
      }
    }
    setViewMode('rich');
  }, []);

  // Handle textarea input — notify parent (no Crepe sync while in source mode)
  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeRef.current(e.target.value);
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Toggle bar */}
      <div className="flex-shrink-0 px-4 py-1.5 bg-gray-50 border-b border-gray-200 flex items-center gap-1">
        <div className="inline-flex rounded-md bg-gray-200/60 p-0.5">
          <button
            onClick={() => viewMode !== 'rich' && switchToRich()}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              viewMode === 'rich'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Rich Editor
          </button>
          <button
            onClick={() => viewMode !== 'source' && switchToSource()}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              viewMode === 'source'
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            Markdown
          </button>
        </div>
      </div>

      {/* Editor area */}
      <div className="flex-1 overflow-hidden relative">
        {/* Rich editor (Crepe) — hidden when in source mode */}
        <div
          ref={editorDivRef}
          className="absolute inset-0 overflow-auto"
          style={{ display: viewMode === 'rich' ? 'block' : 'none' }}
        />

        {/* Source editor (textarea) — hidden when in rich mode */}
        <textarea
          ref={textareaRef}
          defaultValue={value}
          onChange={handleTextareaChange}
          readOnly={readOnly}
          className="absolute inset-0 w-full h-full p-4 font-mono text-sm text-gray-800 bg-white resize-none outline-none leading-relaxed"
          style={{ display: viewMode === 'source' ? 'block' : 'none' }}
          spellCheck={false}
          placeholder="Write markdown here..."
        />

        {/* Loading overlay */}
        {!ready && viewMode === 'rich' && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-80">
            <span className="text-sm text-gray-400">Loading editor...</span>
          </div>
        )}
      </div>
    </div>
  );
}
