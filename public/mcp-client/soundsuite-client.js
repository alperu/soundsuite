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
 *   Never fetch /api/config bare. It no longer returns key values (apiKeys is
 *   { provider: { configured, last4 } } and ?key=<row> is refused 403), but there is
 *   still no reason to read it. The one useful read is ?resolve=localModels.
 */

(function () {
  const ss = {
    version: '1.1.0',
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


  // ====== v1.1 — computed helpers ==========================================
  // Every figure these return is computed or quoted from the server. Nothing is
  // remembered. If a number could go stale in a document, it belongs in here.

  const withTimeout = (p, ms, tag) => Promise.race([
    p, new Promise((z) => setTimeout(() => z({ __timeout: true, tag, ms }), ms)),
  ]);

  Object.assign(ss, {
    /** Detokenise a literal so the coverage rule forces a full scan. */
    _detok(pattern) {
      return pattern.replace(/([A-Za-z]{3,})/, (m) => m.slice(0, -1) + '[' + m.slice(-1) + ']');
    },

    /** Centre a snippet on the match instead of the chunk start. */
    _centre(text, match, pad) {
      const t = String(text || ''); const p = pad || 240;
      const i = match ? t.indexOf(match) : 0; const j = i < 0 ? 0 : i;
      return (j > p ? '…' : '') + t.slice(Math.max(0, j - p), j + p + 60).replace(/\s+/g, ' ').trim();
    },

    /**
     * Provenance footer for a scan result. Quotes the server's absence clause
     * verbatim when present; only computes coverage when the server had no
     * reason to state it. Never hand-assemble this.
     */
    provenance(result, corpus) {
      const r = result || ss.last || {}; const W = r.warnings || [];
      const rows = (r.results || []).length;
      const served = W.find((w) => /proven absent from/.test(w)) || null;
      const capped = W.some((w) => /recall was capped/i.test(w));
      const linespan = W.some((w) => /spans a printed transcript line number/i.test(w));
      let coverage = null;
      if (!served && corpus && corpus.documents) {
        const d = corpus.documents;
        coverage = { indexed: d.indexed, total: d.total,
                     pct: (100 * d.indexed / d.total).toFixed(1),   // string: keeps the trailing zero
                     chunks: corpus.chunks && corpus.chunks.total };
      }
      const verdict = rows > 0 ? (capped ? 'matches-found-capped-pool' : 'matches-found')
        : served ? 'proven-absent'
        : r.truncated ? 'inconclusive-truncated'
        : r.nextCursor ? 'inconclusive-more-pages' : 'zero-unqualified';
      const p = ['strategy: ' + (r.strategy || 'unknown')];
      if (r.scanned != null) p.push('scanned: ' + r.scanned.toLocaleString('en-US'));
      if (r.candidatePool != null) p.push('candidatePool: ' + r.candidatePool);
      p.push('rows: ' + rows, 'truncated: ' + !!r.truncated, 'more pages: ' + !!r.nextCursor);
      let line = p.join(' · ');
      if (served) line += '\n' + served;
      else if (coverage) line += '\nIndex covers ' + coverage.indexed + ' of ' + coverage.total +
        ' documents (' + coverage.pct + '%), ' + coverage.chunks.toLocaleString('en-US') +
        ' chunks. An absence is provable only over what is indexed.';
      if (capped) line += '\nCAVEAT: keyword recall was capped — this count may understate.';
      if (linespan) line += '\nCAVEAT: a match spans a printed line number; check the break before quoting.';
      return { line, verdict, servedClause: served, capped, linespan, coverage };
    },

    /** Scan + dedupe + centred snippets + provenance. The everyday call. */
    async digest(pattern, o = {}) {
      const params = Object.assign({ pattern, limit: o.limit || 60 },
        o.caseId ? { caseId: o.caseId } : {}, o.caseIds ? { caseIds: o.caseIds } : {},
        o.mode ? { mode: o.mode } : {}, o.fold === false ? { fold: false } : {},
        o.linePermissive === false ? { linePermissive: false } : {});
      await ss.exec('scan_for_pattern', params, o);
      const L = ss.last || {};
      if (L.error) return { error: L.error };
      const seen = new Set(); const out = [];
      for (const r of L.results || []) {
        const snip = ss._centre(r.text, r.match, o.pad);
        const key = snip.slice(0, 110);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ cite: String(r.citationShort || r.document || '').slice(0, 64),
                   page: r.page, type: r.filingType, caseId: r.caseId,
                   chunkId: r.chunkId, snip });
      }
      let corpus = null;
      if (!(L.warnings || []).some((w) => /proven absent from/.test(w))) {
        await ss.exec('corpus_status', {}); corpus = ss.last; ss.last = L;
      }
      return { raw: (L.results || []).length, unique: out.length,
               provenance: ss.provenance(L, corpus), passages: out };
    },

    /**
     * The control check from §3: run the pattern and a detokenised variant and
     * compare. Disagreement means the result was about recall, not the corpus.
     */
    async control(pattern, o = {}) {
      const alt = ss._detok(pattern);
      const run = async (p) => {
        await ss.exec('scan_for_pattern',
          Object.assign({ pattern: p, limit: o.limit || 60 },
            o.caseId ? { caseId: o.caseId } : {}, o.caseIds ? { caseIds: o.caseIds } : {}), o);
        const L = ss.last || {};
        return { pattern: p, n: (L.results || []).length, strategy: L.strategy,
                 scanned: L.scanned, docs: [...new Set((L.results || [])
                   .map((r) => String(r.citationShort || r.document || '')))].sort() };
      };
      const a = await run(pattern);
      const b = alt === pattern ? null : await run(alt);
      if (!b) return { a, note: 'pattern already detokenised — no control possible' };
      const same = a.n === b.n && JSON.stringify(a.docs) === JSON.stringify(b.docs);
      return { a, b, agree: same,
               verdict: same ? 'control passed — the result is about the corpus'
                             : 'CONTROL FAILED — the two disagree; the result is about recall' };
    },

    /** Paginate a scan to exhaustion, deduped by chunkId. */
    async exhaust(pattern, o = {}) {
      let cursor = null; const rows = []; const seen = new Set();
      let pages = 0; let escalated = false; const maxPages = o.maxPages || 20;
      do {
        await ss.exec('scan_for_pattern',
          Object.assign({ pattern, limit: o.limit || 50 },
            o.caseId ? { caseId: o.caseId } : {}, o.caseIds ? { caseIds: o.caseIds } : {},
            cursor ? { cursor } : {}), o);
        const L = ss.last || {};
        if (L.error) return { error: L.error, pages };
        pages++;
        if ((L.warnings || []).some((w) => /escalating to a full regex scan/i.test(w))) escalated = true;
        for (const r of L.results || []) {
          const k = r.chunkId || (r.document + ':' + r.page + ':' + String(r.text).slice(0, 40));
          if (!seen.has(k)) { seen.add(k); rows.push(r); }
        }
        cursor = L.nextCursor;
      } while (cursor && pages < maxPages);
      return { pages, unique: rows.length, exhausted: !cursor, escalated,
               note: escalated ? 'a page escalated mid-answer; earlier rows may repeat — deduped by chunkId' : undefined,
               rows };
    },

    /** Widen a hit. Reads the envelope flags, not the array length. */
    async widen(chunkId, o = {}) {
      await ss.exec('get_chunk_context',
        { chunkId, before: o.before == null ? 2 : o.before, after: o.after == null ? 2 : o.after }, o);
      const L = ss.last || {};
      if (L.error) return { error: L.error };
      return {
        atDocumentStart: L.atDocumentStart, atDocumentEnd: L.atDocumentEnd,
        contiguous: L.contiguous, orderingAmbiguous: L.orderingAmbiguous,
        containsDraft: L.containsDraft, notes: L.notes,
        got: { before: L.returnedBefore, after: L.returnedAfter },
        safeToMerge: L.contiguous === true && !L.containsDraft && !L.orderingAmbiguous,
        chunks: (L.chunks || []).map((c) => ({ page: c.page, idx: c.chunkIndex,
          isTarget: c.isTarget, text: String(c.text || '').replace(/\s+/g, ' ') })),
      };
    },

    /** §3a speaker attribution from printed transcript labels. */
    async speakers(label, o = {}) {
      const rx = new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      await ss.exec('scan_for_pattern',
        Object.assign({ pattern: label.replace(/\./g, '\\.'), limit: o.limit || 100 },
          o.caseId ? { caseId: o.caseId } : {}), o);
      const L = ss.last || {};
      if (L.error) return { error: L.error };
      const turns = [];
      for (const r of L.results || []) {
        const parts = String(r.text || '')
          .split(/(?=(?:MR\.|MS\.|MRS\.|THE COURT|THE WITNESS)\s*[A-Z'-]*\s*:)/);
        for (const q of parts) if (rx.test(q.trim()))
          turns.push({ cite: r.citationShort, page: r.page, chunkId: r.chunkId,
                       text: q.replace(/\s+/g, ' ').slice(0, 400) });
      }
      return { rows: (L.results || []).length, turns: turns.length,
               basis: 'labels printed in the transcript text, not speakers-column facts',
               caveat: 'a chunk opening mid-turn loses its first partial turn — recover with ss.widen()',
               items: turns };
    },

    /**
     * Health that actually exercises the path. `notReady` alone is not evidence:
     * it read [] while retrieval hung and [] while it was healthy.
     */
    async preflight(o = {}) {
      const out = { at: new Date().toISOString() };
      try {
        const g = await fetch('/api/admin/gpu-fleet').then((r) => r.json());
        out.fleet = (g.sidecars || []).map((x) => {
          const declared = (x.containers || []).map((c) => c.replace(/^ss-/, ''));
          const reported = Object.keys((x.sidecarStatus || {}).containers || {});
          return { host: x.hostname, status: x.status, declared, reported,
                   unreported: declared.filter((d) => !reported.includes(d)) };
        });
        out.fleetGaps = out.fleet.filter((f) => f.status === 'connected' && f.unreported.length)
          .map((f) => f.host + ' declares ' + f.unreported.join(',') + ' but reports nothing');
        out.minOnline = g.minOnline;
      } catch (e) { out.fleet = 'unreachable: ' + e.message; }
      try { out.notReady = (await ss.tools('local')).notReady; } catch (e) { out.notReady = 'err'; }
      await ss.exec('corpus_status', {});
      const S = ss.last || {};
      if (S.documents) out.corpus = { documents: S.documents.indexed + '/' + S.documents.total,
        pct: (100 * S.documents.indexed / S.documents.total).toFixed(1) + '%',
        chunks: S.chunks && S.chunks.total, byStatus: S.documents.byStatus };
      const t0 = Date.now();
      const probe = await withTimeout(
        ss.exec('query_case_knowledge', { query: o.probe || 'representation status', limit: 1 }),
        o.timeoutMs || 15000, 'retrieval');
      out.retrieval = probe && probe.__timeout
        ? { ok: false, timedOutAfterMs: probe.ms, note: 'embedding/rerank path is not serving' }
        : { ok: true, ms: Date.now() - t0 };
      out.verdict = out.retrieval.ok
        ? (out.fleetGaps && out.fleetGaps.length ? 'degraded — retrieval works, fleet has unreported containers' : 'healthy')
        : 'BLOCKED — retrieval path hangs; scan_for_pattern still works (no model path)';
      return out;
    },

    /**
     * Self-describing catalogue. Drift between code and docs is REPORTED, not
     * hidden — that is the point. Never hand-maintain a list of these elsewhere.
     */
    help(name) {
      const docs = {
        exec: ['tool, params, opts', 'run any tool; full payload lands in ss.last'],
        tools: ['profile', 'catalogue + notReady for a profile'],
        ask: ['query, {limit, caseId}', 'semantic passages (query_case_knowledge)'],
        scan: ['pattern, {limit, caseId}', 'raw regex scan'],
        digest: ['pattern, {limit, caseId, caseIds, pad}', 'scan + dedupe + centred snippets + provenance — the everyday call'],
        control: ['pattern, {caseId}', 'detokenised control check; disagreement means a recall defect'],
        exhaust: ['pattern, {limit, caseId, maxPages}', 'paginate to exhaustion, deduped by chunkId'],
        widen: ['chunkId, {before, after}', 'get_chunk_context; returns safeToMerge from the flags'],
        speakers: ['label, {caseId}', 'transcript turns for MR./MS./THE COURT labels'],
        provenance: ['result, corpus', 'citable footer; quotes the server clause verbatim'],
        preflight: ['{timeoutMs, probe}', 'fleet gaps + corpus + a TIMED retrieval probe'],
        research: ['query, {mode, maxEvidence}', 'fast returns evidence; deep tiers return a jobId'],
        status: ['jobId, {kind}', 'poll a job'], result: ['jobId, {kind}', 'fetch a finished job'],
        cancel: ['jobId, {kind}', 'cancel a job'], explain: ['query', 'dry run (routed only)'],
        cites: ['n', 'cite-ready lines from ss.last'], item: ['i', 'one full item from ss.last'],
        fire: ['key, tool, params', 'run in background'], peek: ['key', 'check a background run'],
        summarize: ['j', 'compact view of any payload'], mcp: ['name', 'JSON-RPC surface at :9191'],
        help: ['name?', 'this'],
      };
      if (name) return docs[name] ? { name, args: docs[name][0], why: docs[name][1] } : 'no such function: ' + name;
      const fns = Object.keys(ss).filter((k) => typeof ss[k] === 'function' && k[0] !== '_');
      const undocumented = fns.filter((f) => !docs[f]);
      const orphanedDocs = Object.keys(docs).filter((d) => !fns.includes(d));
      return {
        version: ss.version,
        functions: fns.filter((f) => docs[f]).map((f) => f + '(' + docs[f][0] + ') — ' + docs[f][1]),
        undocumented, orphanedDocs,
        drift: (undocumented.length || orphanedDocs.length)
          ? 'DRIFT: code and docs disagree — fix before relying on this list' : 'none',
      };
    },
  });

  window.__ss = ss;
  window.ss = ss;
  return 'soundsuite-client ' + ss.version + ' ready at ' + ss.origin;
})();
