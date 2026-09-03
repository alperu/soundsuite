#!/usr/bin/env node
// MCP stdio bridge for Sound Suite.
// Proxies tools/list and tools/call to the Sound Suite REST API.
// stdout is the JSON-RPC channel — all logging goes to stderr.
//
// The bridge is a forwarder. It reads SOUND_SUITE_PROFILE, forwards it to the
// server, and relays job events as MCP notifications. It knows nothing about
// presets, models, or evidence — every policy decision is Sound Suite's.

import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE_URL = (process.env.SOUND_SUITE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
const API_KEY = process.env.MCP_API_KEY || "";
// Fail-closed: anything other than the literal string "routed" is "local".
const PROFILE = process.env.SOUND_SUITE_PROFILE === "routed" ? "routed" : "local";
// stdio transports carry no MCP session id, so one bridge process = one
// session. Without this every stdio client would share the server's
// "anonymous" session (active presets, job listings).
const PROCESS_SESSION_ID = `bridge-${PROFILE}-${randomUUID()}`;
const POLL_INTERVAL_MS = 60_000;

const log = (...args) => console.error(`[sound-suite-bridge:${PROFILE}]`, ...args);

let cachedTools = null; // last successfully fetched, filtered tool list

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

async function fetchCatalog() {
  const res = await fetch(`${BASE_URL}/api/mcp/tools?profile=${PROFILE}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(`GET /api/mcp/tools?profile=${PROFILE} returned HTTP ${res.status}`);
  }
  const data = await res.json();
  const tools = (data.tools || [])
    .filter((t) => t?.config?.enabled !== false && t?.ready === true)
    .map((t) => ({
      name: t.metadata.name,
      description: t.metadata.description || "",
      inputSchema: t.metadata.inputSchema || { type: "object", properties: {} },
    }));
  cachedTools = tools;
  return tools;
}

async function getTools() {
  try {
    return await fetchCatalog();
  } catch (err) {
    log(`catalog fetch failed: ${err.message}`);
    if (cachedTools) {
      log(`serving cached catalog (${cachedTools.length} tools)`);
      return cachedTools;
    }
    throw err;
  }
}

const server = new Server(
  { name: `sound-suite-${PROFILE}`, version: "1.1.0" },
  { capabilities: { tools: { listChanged: true }, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: await getTools() };
});

// ---------------------------------------------------------------------------
// Job event relay
//
// When a job tool (research_start / report_start) returns { jobId, kind } and
// the client supplied a progressToken, tail the job's NDJSON event stream in
// the background and translate events into MCP notifications:
//   progress -> notifications/progress   (progress = event seq, message = phase text)
//   thoughts -> notifications/message    (level info, logger sound-suite)
// The tail stops on result / error / cancelled, or when the fetch fails.
// It never blocks the tool response and never throws.
// ---------------------------------------------------------------------------

function progressMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  const parts = [];
  if (payload.phase) parts.push(String(payload.phase));
  if (payload.message) parts.push(String(payload.message));
  if (payload.rlmRound != null) {
    parts.push(
      payload.rlmMaxRounds != null
        ? `rlm round ${payload.rlmRound}/${payload.rlmMaxRounds}`
        : `rlm round ${payload.rlmRound}`
    );
  }
  return parts.join(" — ");
}

function thoughtsText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") {
    if (typeof payload.text === "string") return payload.text;
    if (typeof payload.message === "string") return payload.message;
  }
  return JSON.stringify(payload);
}

async function relayJobEvents({ jobId, kind, progressToken, sessionId }) {
  const url = `${BASE_URL}/api/mcp/${encodeURIComponent(kind)}/${encodeURIComponent(jobId)}/events?from=0`;
  const headers = authHeaders({ Accept: "application/x-ndjson" });
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${kind}/${jobId}/events returned HTTP ${res.status}`);
  }

  const notify = (method, params) =>
    server.notification({ method, params }).catch((err) => {
      log(`notification ${method} failed: ${err.message}`);
    });

  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      return; // skip malformed lines
    }
    switch (evt.type) {
      case "progress":
        await notify("notifications/progress", {
          progressToken,
          progress: typeof evt.seq === "number" ? evt.seq : 0,
          message: progressMessage(evt.payload),
        });
        break;
      case "thoughts": {
        const text = thoughtsText(evt.payload);
        if (text) {
          await notify("notifications/message", {
            level: "info",
            logger: "sound-suite",
            data: text,
          });
        }
        break;
      }
      case "result":
      case "error":
      case "cancelled":
        done = true;
        break;
      default:
        break; // evidence / token: delivered via *_status, not relayed here
    }
  };

  const reader = res.body.getReader();
  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while (!done && (idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        await handleLine(line);
      }
    }
    if (!done && buffer.trim()) await handleLine(buffer);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  log(`job ${kind}/${jobId} event relay finished`);
}

function maybeStartRelay(data, progressToken, sessionId) {
  if (progressToken === undefined || progressToken === null) return;
  if (!data || typeof data !== "object") return;
  const { jobId, kind } = data;
  if (typeof jobId !== "string" || (kind !== "research" && kind !== "report")) return;
  log(`tailing ${kind}/${jobId} events for progressToken ${String(progressToken)}`);
  relayJobEvents({ jobId, kind, progressToken, sessionId }).catch((err) => {
    log(`job ${kind}/${jobId} event relay stopped: ${err.message}`);
  });
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const progressToken = request.params._meta?.progressToken;
  const sessionId = extra?.sessionId || PROCESS_SESSION_ID;
  try {
    const headers = authHeaders({ "Content-Type": "application/json" });
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const res = await fetch(`${BASE_URL}/api/mcp/execute`, {
      method: "POST",
      headers,
      // NB: the execute route destructures { tool, params, profile } — an
      // "arguments" key is silently dropped and every required parameter goes
      // missing. `profile` is always sent so the server can enforce policy.
      body: JSON.stringify({ tool: name, params: args || {}, profile: PROFILE }),
    });

    let data;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok || (data && typeof data === "object" && data.error)) {
      const message =
        data && typeof data === "object" && data.error
          ? `${data.error.code ? `[${data.error.code}] ` : ""}${data.error.message || JSON.stringify(data.error)}`
          : `HTTP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
      return { content: [{ type: "text", text: message }], isError: true };
    }

    maybeStartRelay(data, progressToken, sessionId);

    const resultText = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    return { content: [{ type: "text", text: resultText }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Bridge error calling ${name}: ${err.message}` }],
      isError: true,
    };
  }
});

function toolListSignature(tools) {
  return tools
    .map((t) => t.name)
    .sort()
    .join(",");
}

function startCatalogPolling() {
  let lastSignature = cachedTools ? toolListSignature(cachedTools) : null;
  setInterval(async () => {
    try {
      const tools = await fetchCatalog();
      const sig = toolListSignature(tools);
      if (lastSignature !== null && sig !== lastSignature) {
        log(`tool list changed (${tools.length} tools) — notifying client`);
        try {
          server.sendToolListChanged();
        } catch (err) {
          log(`sendToolListChanged failed: ${err.message}`);
        }
      }
      lastSignature = sig;
    } catch (err) {
      log(`catalog poll failed: ${err.message}`);
    }
  }, POLL_INTERVAL_MS).unref();
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected via stdio; backend ${BASE_URL}; profile ${PROFILE}`);
  // Prime the cache so the first tools/list is fast and polling has a baseline.
  try {
    await fetchCatalog();
    log(`catalog primed: ${cachedTools.length} tools`);
  } catch (err) {
    log(`initial catalog fetch failed: ${err.message}`);
  }
  startCatalogPolling();
}

main().catch((err) => {
  log(`fatal: ${err.stack || err.message}`);
  process.exit(1);
});
