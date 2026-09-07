/*
 * soundsuite-client.js — browser-pane client for the Sound Suite MCP surface.
 *
 * WHY THIS EXISTS
 *   Sound Suite listens on the Mac's loopback. A Cowork session can run code in
 *   three places and only one of them can reach it:
 *     - cloud container (Bash)      -> different machine, no route
 *     - device_bash                 -> isolated Linux VM, its localhost is not the Mac's
 *     - the desktop app's browser pane -> runs ON the Mac. This is the only transport.
 *   So every call here is a same-origin fetch() executed inside that pane.
 *
 * HOW IT IS LOADED
 *   The pane cannot import from a file:// path, and the proxy origin (:9191) cannot
 *   fetch across to :3000. So this file is injected inline: read it, pass the text to
 *   Claude_Browser__javascript_tool. One source of truth, works at either origin.
 *
 * ORIGIN RULES
 *   Point the pane at the origin you want to talk to, then load this:
 *     http://localhost:3000/api/health   -> REST surface  (ss.exec, ss.tools)  [preferred]
 *     http://localhost:9191/             -> MCP/JSON-RPC via mcp-proxy (ss.mcp)
 *   Cross-origin fetch fails with a bare TypeError. That is CORS, not a dead port.
 *
 * CONSTRAINTS THIS ENCODES (all learned the hard way)
 *   - javascript_tool aborts at 45s; `deep` runs ~125s  -> use ss.fire()/ss.peek()
 *   - a result over ~60k chars aborts the call          -> helpers return summaries;
 *                                                          full payload stays in ss.last
 *   - retrieval knobs are NESTED under `retrieval`      -> a top-level maxEvidence is
 *                                                          silently ignored
 *   - `fast` is the only synchronous tier; deep/deep-report/deep-rlm return a jobId
 *
 * PRIVACY
 *   Evidence text is real case material (cause numbers, party names, filing titles).
 *   Quote it in conversation; never write it to a file, report, or commit. See CLAUDE.md.
 *   Never fetch /api/config — it returns live provider API keys in plaintext.
 */

(function () {
  const ss = {
    version: '1.0.0',
    origin: location.origin,
    last: null,     // full payload of the most recent exec — extract from here
    runs: {},       // background runs keyed by name

    // ---- REST surface (pane at http://localhost:3000) --------------------

    /** Execute one tool. Returns a SUMMARY; full JSON lands in ss.last. */
    async exec(tool, params = {}, opts = {}) {
      const body = { profile: opts.profile || 'local', tool, params };
      if (opts.provider) body.provider = opts.provider;
      if (opts.model) body.model = opts.model;
      const t0 = performance.now();
      const r = await fetch('/api/mcp/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const txt = await r.text();
      let j = null;
      try { j = JSON.parse(txt); } catch (e) { /* non-JSON error page */ }
      ss.last = j;
      return {
        status: r.status,
        ms: Math.round(performance.now() - t0),
        bytes: txt.length,
        error: j && j.error ? j.error.code : undefined,
        summary: ss.summarize(j),
      };
    },

    /** Compact view of any tool result — safe to return from javascript_tool. */
    summarize(j) {
      if (!j || typeof j !== 'object') return null;
      if (j.error) return { error: j.error.code, message: String(j.error.message || '').slice(0, 200) };
      if (j.promoted || j.jobId) return { promoted: true, jobId: j.jobId, kind: j.kind, status: j.status };
      const out = {};
      if (j.evidence) {
        const e0 = j.evidence[0] || {};
        out.evidence = j.evidence.length;
        out.mode = j.routing && j.routing.mode;
        out.caps = j.stats && j.stats.caps;
        out.phases = j.stats && j.stats.phases;
        out.models = j.modelsUsed;
        out.outline = j.outline === null ? null
          : j.outline ? { sections: (j.outline.sections || []).length, gaps: (j.outline.gaps || []).length }
          : undefined;
        out.firstCite = { citationShort: String(e0.citationShort || '').slice(0, 70), page: e0.page };
      }
      if (j.results) out.results = j.results.length;
      if (j.contradictions) out.contradictions = j.contradictions.length;
      if (j.tier) { out.tier = j.tier; out.resolved = j.resolved; out.costClass = j.costClass;
                    out.estimatedSeconds = j.estimatedSeconds; out.wouldPromoteToJob = j.wouldPromoteToJob; }
      if (j.phase) { out.phase = j.phase; out.jobStatus = j.status; out.elapsedMs = j.elapsedMs;
                     out.streamed = j.evidence ? j.evidence.length : undefined; }
      return Object.keys(out).length ? out : { keys: Object.keys(j).slice(0, 12) };
    },

    /** Tool catalogue for a profile. */
    async tools(profile = 'local') {
      const r = await fetch('/api/mcp/tools?profile=' + encodeURIComponent(profile));
      const j = await r.json().catch(() => null);
      const t = (j && j.tools) || [];
      return {
        status: r.status,
        profile: j && j.profile,
        providersAllowed: j && j.providersAllowed,
        n: t.length,
        names: t.map((x) => x.metadata && x.metadata.name),
        notReady: t.filter((x) => !x.ready).map((x) => x.metadata && x.metadata.name),
      };
    },

    // ---- convenience wrappers --------------------------------------------

    /** Passages on a topic, with citations. ~6s. */
    ask(query, o = {}) {
      return ss.exec('query_case_knowledge',
        Object.assign({ query, limit: o.limit || 5 }, o.caseId ? { caseId: o.caseId } : {},
                      o.searchMode ? { searchMode: o.searchMode } : {}), o);
    },

    /** Exact regex scan. ~1.5s, no LLM — the precision tool. */
    scan(pattern, o = {}) {
      return ss.exec('scan_for_pattern',
        Object.assign({ pattern, limit: o.limit || 10 }, o.caseId ? { caseId: o.caseId } : {}), o);
    },

    /**
     * Research. `fast` returns evidence; deep tiers return { jobId }.
     * ALWAYS pass a small maxEvidence — the 40-item default is ~55KB.
     */
    research(query, o = {}) {
      const params = { query, mode: o.mode || 'auto' };
      if (o.caseId) params.caseId = o.caseId;
      params.retrieval = Object.assign(
        { maxEvidence: o.maxEvidence || 15, maxCharsPerChunk: o.maxCharsPerChunk || 800 },
        o.retrieval || {});
      return ss.exec('research_evidence', params, o);
    },

    /** Job polling. kind: 'research' (local) | 'report' (routed). */
    status(jobId, o = {}) { return ss.exec((o.kind || 'research') + '_status', { jobId }, o); },
    result(jobId, o = {}) { return ss.exec((o.kind || 'research') + '_result', { jobId }, o); },
    cancel(jobId, o = {}) { return ss.exec((o.kind || 'research') + '_cancel', { jobId }, o); },

    /** Dry run: which tier and model a question would use. routed profile only. */
    explain(query) { return ss.exec('routing_explain', { query }, { profile: 'routed' }); },

    // ---- extracting from the last payload without blowing the size cap ----

    /** Cite-ready lines from ss.last. Keep n small. */
    cites(n = 10) {
      const ev = (ss.last && (ss.last.evidence || ss.last.results)) || [];
      return ev.slice(0, n).map((e, i) => ({
        i, cite: e.citationShort || e.citation || e.document || e.documentId,
        page: e.page, score: e.score && Number(e.score.toFixed(3)),
        snippet: String(e.text || '').slice(0, 180),
      }));
    },

    /** One full item from ss.last, by index. */
    item(i = 0) { const ev = (ss.last && (ss.last.evidence || ss.last.results)) || []; return ev[i] || null; },

    // ---- background runs (anything slower than ~40s) ---------------------

    /** Start a call in the background. Then: Bash sleep, then ss.peek(key). */
    fire(key, tool, params, opts) {
      ss.runs[key] = { started: Date.now(), done: false };
      ss.exec(tool, params, opts)
        .then((r) => { ss.runs[key] = { done: true, r }; })
        .catch((e) => { ss.runs[key] = { done: true, err: String(e).slice(0, 160) }; });
      return 'fired:' + key;
    },

    peek(key) {
      const v = ss.runs[key];
      if (!v) return 'no such run';
      return v.done ? { done: true, ...(v.r || {}), err: v.err }
                    : { done: false, elapsedMs: Date.now() - v.started };
    },

    // ---- MCP/JSON-RPC surface (pane at http://localhost:9191) ------------

    /** Session against a proxy path, e.g. ss.mcp('sound-suite-local'). */
    mcp(name) {
      const url = location.origin + '/' + name + '/mcp';
      let sid = null;
      const post = async (b) => {
        const h = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
        if (sid) h['mcp-session-id'] = sid;
        const t0 = performance.now();
        const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(b) });
        const got = r.headers.get('mcp-session-id'); if (got) sid = got;
        const t = await r.text();
        let p = null;
        if (t.indexOf('data:') >= 0) {
          const lines = t.split('\n').filter((x) => x.indexOf('data:') === 0);
          try { p = JSON.parse(lines[lines.length - 1].slice(5).trim()); } catch (e) {}
        }
        if (!p) { try { p = JSON.parse(t); } catch (e) { p = { raw: t.slice(0, 120) }; } }
        return { status: r.status, ms: Math.round(performance.now() - t0), body: p };
      };
      return {
        async connect() {
          const i = await post({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {},
                      clientInfo: { name: 'soundsuite-client', version: ss.version } } });
          await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
          return { status: i.status, server: i.body?.result?.serverInfo?.name,
                   capabilities: Object.keys(i.body?.result?.capabilities || {}) };
        },
        async list() {
          const l = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
          const t = l.body?.result?.tools || [];
          return { status: l.status, n: t.length, names: t.map((x) => x.name) };
        },
        async call(name, args) {
          const c = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call',
                                 params: { name, arguments: args || {} } });
          const res = c.body?.result;
          const txt = res?.content?.[0]?.text || '';
          try { ss.last = JSON.parse(txt); } catch (e) { ss.last = txt; }
          return { ms: c.ms, isError: !!res?.isError, bytes: txt.length,
                   structuredContent: !!res?.structuredContent,
                   summary: ss.summarize(ss.last) };
        },
      };
    },
  };

  window.__ss = ss;
  window.ss = ss;
  return 'soundsuite-client ' + ss.version + ' ready at ' + ss.origin;
})();
