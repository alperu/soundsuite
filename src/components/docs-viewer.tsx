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

interface CandidateAddress {
  url: string;
  host: string;
  source: string;
  recommended?: boolean;
}

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
  hostname: string;
  candidates: CandidateAddress[];
}

function substitute(template: string, info: SystemInfo | null, masterUrlOverride?: string): string {
  if (!info) return template;
  const masterUrl = masterUrlOverride || info.masterUrl;
  const masterHost = (() => {
    try { return new URL(masterUrl).host; } catch { return info.masterHost; }
  })();
  const map: Record<string, string> = {
    MASTER_URL: masterUrl,
    MASTER_HOST: masterHost,
    MCP_HTTP_URL: `${masterUrl}/api/mcp`,
    MCP_RPC_URL: `${masterUrl}/api/mcp/rpc`,
    MCP_AUTH_MODE: info.mcpAuthMode,
    SIDECAR_VERSION: info.sidecarVersion,
    SIDECAR_TARBALL_URL: info.sidecarTarballUrl.replace(info.masterUrl, masterUrl),
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
  const [selectedMasterUrl, setSelectedMasterUrl] = useState<string>('');

  // Fetch runtime values once
  useEffect(() => {
    fetch('/api/docs/info')
      .then(r => r.json())
      .then((data: SystemInfo) => {
        setInfo(data);
        // Default the selector to the recommended candidate, falling back to masterUrl
        const recommended = data.candidates?.find(c => c.recommended);
        setSelectedMasterUrl(recommended?.url || data.masterUrl);
      })
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

  const rendered = useMemo(() => substitute(content, info, selectedMasterUrl), [content, info, selectedMasterUrl]);
  const activeDoc = DOCS.find(d => d.slug === activeSlug);

  // Build the right-column TOC by scanning the rendered markdown for ## / ###
  // headings. Slugs match the id we attach via the ReactMarkdown overrides
  // below so anchor clicks scroll to the right spot. Skips headings inside
  // fenced code blocks (a `## ` line inside ```...``` shouldn't appear in TOC).
  const toc = useMemo(() => {
    const lines = rendered.split('\n');
    const items: Array<{ slug: string; text: string; level: 2 | 3 }> = [];
    let inFence = false;
    const used = new Set<string>();
    const slugify = (s: string) =>
      s.toLowerCase().trim()
        .replace(/[`*_~]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    for (const raw of lines) {
      if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const m = raw.match(/^(#{2,3})\s+(.+?)\s*$/);
      if (!m) continue;
      const level = m[1].length as 2 | 3;
      const text = m[2].replace(/<[^>]+>/g, '').trim();
      let slug = slugify(text);
      if (!slug) continue;
      let n = 1;
      while (used.has(slug)) { slug = `${slugify(text)}-${++n}`; }
      used.add(slug);
      items.push({ slug, text, level });
    }
    return items;
  }, [rendered]);

  const [activeAnchor, setActiveAnchor] = useState<string>('');
  useEffect(() => {
    if (typeof window === 'undefined' || toc.length === 0) return;
    const headingEls = toc
      .map(t => document.getElementById(t.slug))
      .filter((el): el is HTMLElement => !!el);
    if (headingEls.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveAnchor(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -60% 0px' },
    );
    headingEls.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [toc, rendered]);

  const effectiveHost = (() => {
    try { return selectedMasterUrl ? new URL(selectedMasterUrl).host : info?.masterHost ?? ''; } catch { return info?.masterHost ?? ''; }
  })();

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
          <div className="mx-3 mt-6 p-3 rounded-lg bg-white border border-gray-200 text-[11px] text-gray-600 space-y-2">
            <div>
              <div className="font-semibold text-gray-700 mb-1">Master URL</div>
              <select
                value={selectedMasterUrl}
                onChange={(e) => setSelectedMasterUrl(e.target.value)}
                className="w-full text-[11px] font-mono px-2 py-1.5 border border-gray-300 rounded bg-white text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                title="Pick which IP/URL to use in copy-paste snippets"
              >
                {info.candidates.map((c) => (
                  <option key={c.url} value={c.url}>
                    {c.host}{c.recommended ? '  (recommended)' : ''}
                  </option>
                ))}
              </select>
              <div className="text-[10px] text-gray-400 mt-1 leading-snug">
                Source: <span className="font-mono">{info.candidates.find(c => c.url === selectedMasterUrl)?.source ?? '—'}</span>
              </div>
            </div>
            <div className="border-t border-gray-100 pt-2">
              <div><span className="text-gray-400">host</span>: <span className="font-mono">{info.hostname}</span></div>
              <div><span className="text-gray-400">sidecar</span>: <span className="font-mono">v{info.sidecarVersion}</span></div>
              <div><span className="text-gray-400">auth</span>: <span className="font-mono">{info.mcpAuthMode}</span></div>
            </div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto bg-white">
        <div className="max-w-5xl mx-auto px-8 py-8">
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
                prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:bg-slate-100 prose-code:text-slate-800 prose-code:font-mono prose-code:text-[0.88em] prose-code:font-medium prose-code:before:content-none prose-code:after:content-none
                prose-pre:bg-transparent prose-pre:p-0 prose-pre:my-0
              "
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h2: ({ children }) => {
                    const text = String(children ?? '').replace(/<[^>]+>/g, '').trim();
                    const slug = text.toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                    return <h2 id={slug} className="scroll-mt-20">{children}</h2>;
                  },
                  h3: ({ children }) => {
                    const text = String(children ?? '').replace(/<[^>]+>/g, '').trim();
                    const slug = text.toLowerCase().replace(/[`*_~]/g, '').replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                    return <h3 id={slug} className="scroll-mt-20">{children}</h3>;
                  },
                  pre: ({ children }) => {
                    // ReactMarkdown wraps <code> inside <pre>. Extract the raw text for copy.
                    const codeNode = (children as any)?.props?.children ?? '';
                    const codeText = typeof codeNode === 'string'
                      ? codeNode.replace(/\n$/, '')
                      : Array.isArray(codeNode)
                        ? codeNode.join('').replace(/\n$/, '')
                        : String(codeNode);
                    const rawLang = (children as any)?.props?.className?.match(/language-(\w+)/)?.[1] ?? '';
                    const language = rawLang || 'text';
                    const langLabel: Record<string, string> = {
                      bash: 'shell', sh: 'shell', zsh: 'shell', powershell: 'PowerShell',
                      json: 'JSON', yaml: 'YAML', ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript',
                    };
                    return (
                      <div className="relative my-4 rounded-lg overflow-hidden border border-slate-200 bg-slate-50 shadow-sm">
                        <div className="flex items-center justify-between px-3 py-1.5 bg-white border-b border-slate-200">
                          <span className="text-[11px] font-medium text-slate-500 tracking-wide">
                            {langLabel[language] || language}
                          </span>
                          <CopyButton text={codeText} />
                        </div>
                        <pre className="p-4 overflow-x-auto text-[13px] leading-relaxed text-slate-800 font-mono whitespace-pre">
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
                  // Force-download links to script files instead of navigating (.bat tries to render as text in some browsers)
                  a: ({ href, children, ...props }: any) => {
                    const isScript = typeof href === 'string' && /\.(sh|bat|ps1|tar\.gz|zip)(\?|$)/.test(href);
                    if (isScript) {
                      const filename = href.split('/').pop()?.split('?')[0];
                      return (
                        <a
                          href={href}
                          download={filename}
                          {...props}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 mr-2 my-1 rounded-md border border-blue-200 bg-blue-50 text-blue-700 text-xs font-medium hover:bg-blue-100 hover:border-blue-300 transition-colors no-underline"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                          </svg>
                          {children}
                        </a>
                      );
                    }
                    return <a href={href} {...props}>{children}</a>;
                  },
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
            <div className="mt-12 pt-4 border-t border-gray-200 text-[11px] text-gray-400 leading-relaxed">
              Snippets above are substituted with the URL you picked in the left panel:&nbsp;
              <span className="font-mono text-gray-500">{effectiveHost}</span>.
              Switch the dropdown to regenerate snippets for a different IP / hostname.
            </div>
          )}
        </div>
      </main>

      {/* Right rail — TOC of the active doc. Hidden when there are fewer than
          two anchorable sections (very short docs). */}
      {toc.length >= 2 && (
        <aside className="hidden xl:block w-60 flex-shrink-0 border-l border-gray-200 bg-gray-50 overflow-y-auto py-4 px-3">
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 px-2">On this page</div>
          <nav className="space-y-0.5">
            {toc.map(item => (
              <a
                key={item.slug}
                href={`#${item.slug}`}
                onClick={(e) => {
                  e.preventDefault();
                  const el = document.getElementById(item.slug);
                  if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    window.history.replaceState(null, '', `#${item.slug}`);
                    setActiveAnchor(item.slug);
                  }
                }}
                className={`block text-[11px] leading-snug px-2 py-1 rounded transition-colors ${
                  item.level === 3 ? 'pl-5' : ''
                } ${
                  activeAnchor === item.slug
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                {item.text}
              </a>
            ))}
          </nav>
        </aside>
      )}
    </div>
  );
}
