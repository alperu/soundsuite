'use client';

import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from '@/components/copy-button';

interface DocFile {
  slug: string;
  path: string;
  title: string;
  description: string;
}

const DOCS: DocFile[] = [
  {
    slug: 'install-sidecar',
    path: '/docs/install-sidecar.md',
    title: 'Install GPU Sidecar',
    description: 'Run the sidecar agent on a GPU host (Linux / macOS / Windows).',
  },
  {
    slug: 'install-mcp',
    path: '/docs/install-mcp.md',
    title: 'Connect MCP Client',
    description: 'Wire up Claude Desktop, Cursor, or VSCode to the MCP server.',
  },
];

interface SystemInfo {
  masterUrl: string;
  masterHost: string;
  mcpHttpUrl: string;
  mcpRpcUrl: string;
  mcpAuthMode: string;
  sidecarVersion: string;
  sidecarTarballUrl: string;
  sidecarPort: number;
  serverPort: number;
}

function substitute(template: string, info: SystemInfo | null): string {
  if (!info) return template;
  const map: Record<string, string> = {
    MASTER_URL: info.masterUrl,
    MASTER_HOST: info.masterHost,
    MCP_HTTP_URL: info.mcpHttpUrl,
    MCP_RPC_URL: info.mcpRpcUrl,
    MCP_AUTH_MODE: info.mcpAuthMode,
    SIDECAR_VERSION: info.sidecarVersion,
    SIDECAR_TARBALL_URL: info.sidecarTarballUrl,
    SIDECAR_PORT: String(info.sidecarPort),
    SERVER_PORT: String(info.serverPort),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => map[key] ?? `{{${key}}}`);
}

export default function DocsViewer() {
  const [activeSlug, setActiveSlug] = useState<string>(() => {
    if (typeof window === 'undefined') return DOCS[0].slug;
    const hash = window.location.hash.slice(1);
    return DOCS.find(d => d.slug === hash)?.slug ?? DOCS[0].slug;
  });
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<SystemInfo | null>(null);

  // Fetch runtime values once
  useEffect(() => {
    fetch('/api/docs/info')
      .then(r => r.json())
      .then(setInfo)
      .catch(() => { /* offline-friendly */ });
  }, []);

  // Fetch active doc when slug changes
  useEffect(() => {
    const doc = DOCS.find(d => d.slug === activeSlug);
    if (!doc) return;
    setLoading(true);
    fetch(doc.path)
      .then(r => r.text())
      .then(text => setContent(text))
      .catch(() => setContent(`# ${doc.title}\n\nFailed to load.`))
      .finally(() => setLoading(false));
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${doc.slug}`);
    }
  }, [activeSlug]);

  const rendered = useMemo(() => substitute(content, info), [content, info]);
  const activeDoc = DOCS.find(d => d.slug === activeSlug);

  return (
    <div className="flex h-full">
      {/* Left rail — doc list */}
      <aside className="w-60 border-r border-gray-200 bg-gray-50 overflow-y-auto py-3">
        <h2 className="px-4 mb-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Documentation</h2>
        <nav className="space-y-0.5">
          {DOCS.map(doc => (
            <button
              key={doc.slug}
              onClick={() => setActiveSlug(doc.slug)}
              className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                activeSlug === doc.slug
                  ? 'bg-blue-50 text-blue-700 border-r-2 border-r-blue-500 font-medium'
                  : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              <div>{doc.title}</div>
              <div className="text-[11px] text-gray-500 mt-0.5 leading-relaxed">{doc.description}</div>
            </button>
          ))}
        </nav>
        {info && (
          <div className="mx-3 mt-6 p-3 rounded-lg bg-white border border-gray-200 text-[11px] text-gray-600 space-y-1">
            <div className="font-semibold text-gray-700 mb-1">Live values</div>
            <div><span className="text-gray-400">master</span>: <span className="font-mono break-all">{info.masterHost}</span></div>
            <div><span className="text-gray-400">sidecar</span>: <span className="font-mono">v{info.sidecarVersion}</span></div>
            <div><span className="text-gray-400">auth</span>: <span className="font-mono">{info.mcpAuthMode}</span></div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-white">
        <div className="max-w-3xl mx-auto px-8 py-8">
          {loading && (
            <div className="text-sm text-gray-500">Loading…</div>
          )}
          {!loading && (
            <article
              className="prose prose-sm max-w-none
                prose-headings:text-gray-900
                prose-h1:text-2xl prose-h1:font-bold prose-h1:mt-0 prose-h1:mb-4
                prose-h2:text-lg prose-h2:font-semibold prose-h2:mt-8 prose-h2:mb-3 prose-h2:border-b prose-h2:border-gray-200 prose-h2:pb-2
                prose-h3:text-base prose-h3:font-semibold prose-h3:mt-6 prose-h3:mb-2
                prose-p:text-gray-700 prose-p:leading-relaxed
                prose-li:text-gray-700
                prose-strong:text-gray-900
                prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline
                prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:bg-gray-100 prose-code:text-pink-700 prose-code:font-mono prose-code:text-[0.9em] prose-code:before:content-none prose-code:after:content-none
                prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-0
              "
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  pre: ({ children }) => {
                    // ReactMarkdown wraps <code> inside <pre>. Extract the raw text for copy.
                    const codeNode = (children as any)?.props?.children ?? '';
                    const codeText = typeof codeNode === 'string'
                      ? codeNode.replace(/\n$/, '')
                      : Array.isArray(codeNode)
                        ? codeNode.join('').replace(/\n$/, '')
                        : String(codeNode);
                    const language = (children as any)?.props?.className?.match(/language-(\w+)/)?.[1] ?? '';
                    return (
                      <div className="relative group my-4 rounded-lg overflow-hidden border border-gray-200 bg-gray-900">
                        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-800 border-b border-gray-700">
                          <span className="text-[11px] font-mono text-gray-400 uppercase tracking-wide">{language || 'text'}</span>
                          <CopyButton text={codeText} className="!text-gray-400 hover:!text-gray-100 hover:!bg-gray-700" />
                        </div>
                        <pre className="p-4 overflow-x-auto text-[13px] leading-relaxed text-gray-100 font-mono">
                          <code>{codeText}</code>
                        </pre>
                      </div>
                    );
                  },
                  // Inline code keeps the prose-code styling above
                  code: ({ inline, className, children, ...props }: any) =>
                    inline ? (
                      <code className={className} {...props}>{children}</code>
                    ) : (
                      <code className={className}>{children}</code>
                    ),
                  table: ({ children }) => (
                    <div className="my-4 overflow-x-auto">
                      <table className="min-w-full text-sm border border-gray-200 rounded-lg">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => (
                    <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 bg-gray-50 border-b border-gray-200">{children}</th>
                  ),
                  td: ({ children }) => (
                    <td className="px-3 py-2 text-gray-700 border-b border-gray-100">{children}</td>
                  ),
                }}
              >
                {rendered}
              </ReactMarkdown>
            </article>
          )}
          {!loading && activeDoc && info && (
            <div className="mt-12 pt-4 border-t border-gray-200 text-[11px] text-gray-400">
              Substituted live values: {Object.entries({
                MASTER_URL: info.masterUrl,
                SIDECAR_VERSION: info.sidecarVersion,
              }).map(([k, v]) => `${k}=${v}`).join(' · ')}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
