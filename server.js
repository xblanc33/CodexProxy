/**
 * Node/Express minimal proxy to log Codex/clients → upstream LLM (OpenAI or LM Studio)
 *
 * Features
 * - Logs full JSON request bodies (messages, params) to console and a file (logs/requests.ndjson)
 * - Forwards to an OpenAI-compatible API base (default: https://api.openai.com)
 * - Supports streaming (SSE) by piping the upstream response
 * - Compatible routes: /v1/chat/completions and /v1/responses (can add more easily)
 * - Config via .env file
 *
 * Usage
 *   1) npm i express dotenv
 *   2) Crée un fichier .env avec par ex. :
 *        PORT=5000
 *        API_BASE=https://api.openai.com
 *        UPSTREAM_API_KEY=sk-...
 *        ALLOW_CLIENT_AUTH=false
 *   3) node server.js
 */

const fs = require('fs');
const { promises: fsp } = fs;
const path = require('path');
const express = require('express');
const crypto = require('crypto');
require('dotenv').config(); // charge .env

const app = express();
app.use(express.json({ limit: '5mb' }));
// Basic CORS support for browser-based clients
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, OpenAI-Organization, OpenAI-Project, OpenAI-Beta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Ensure fetch exists (support Node <18 via node-fetch@3)
if (typeof globalThis.fetch !== 'function') {
  try {
    // Verify node-fetch is installed
    require.resolve('node-fetch');
    // Lazy polyfill: dynamic import keeps CJS compatibility
    globalThis.fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
    console.log('[startup] Using node-fetch polyfill for global fetch');
  } catch (e) {
    console.error('[startup] Global fetch not found and node-fetch is not installed. Install with: npm i node-fetch@3');
    process.exit(1);
  }
}

// Diagnostics: capture unexpected exits/signals/errors
process.on('exit', (code) => {
  console.log(`[process] exit with code ${code}`);
});
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    console.log(`[process] received ${sig}, shutting down`);
    process.exit(0);
  });
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});

const PORT = Number(process.env.PORT || 5000);
const rawNamespace = process.env.API_NAMESPACE;
const API_NAMESPACE = typeof rawNamespace === 'string'
  ? rawNamespace.trim().replace(/^\/+|\/+$/g, '')
  : 'v1';
const API_BASE = (() => {
  const fallbackBase = 'https://api.openai.com';
  const envBase = typeof process.env.API_BASE === 'string' ? process.env.API_BASE.trim() : '';
  let base = envBase || fallbackBase;
  base = base.replace(/\/+$/, '');
  if (API_NAMESPACE && base.toLowerCase().endsWith(`/${API_NAMESPACE.toLowerCase()}`)) {
    base = base.slice(0, -(API_NAMESPACE.length + 1));
  }
  return base;
})();
const ROUTE_PREFIX = API_NAMESPACE ? `/${API_NAMESPACE}` : '';
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY || '';
const ALLOW_CLIENT_AUTH = String(process.env.ALLOW_CLIENT_AUTH || 'false').toLowerCase() === 'true';
const AUTO_PORT = String(process.env.AUTO_PORT || 'true').toLowerCase() === 'true';
const LOG_RAW_BODY = String(process.env.LOG_RAW_BODY || 'true').toLowerCase() === 'true';
const OPENAI_ORG = process.env.OPENAI_ORG || process.env.OPENAI_ORGANIZATION || '';
const OPENAI_PROJECT = process.env.OPENAI_PROJECT || '';
const OPENAI_BETA = process.env.OPENAI_BETA || '';
const FORCE_OPENAI_HEADERS = String(process.env.FORCE_OPENAI_HEADERS || 'false').toLowerCase() === 'true';

const upstreamOverrides = (() => {
  const raw = process.env.UPSTREAM_URL_OVERRIDES;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      console.warn('[config] UPSTREAM_URL_OVERRIDES must be a JSON object of { "route": "url" }');
      return {};
    }
    const entries = Object.entries(parsed)
      .filter(([key, value]) => typeof key === 'string' && typeof value === 'string' && value.trim().length > 0)
      .map(([key, value]) => [key.trim(), value.trim()]);
    return Object.fromEntries(entries);
  } catch (err) {
    console.warn(`[config] Failed to parse UPSTREAM_URL_OVERRIDES: ${err.message}`);
    return {};
  }
})();

function buildRoutePath(segment) {
  const normalized = typeof segment === 'string'
    ? segment.trim().replace(/^\/+/, '')
    : '';
  if (!normalized) {
    return ROUTE_PREFIX || '/';
  }
  if (!ROUTE_PREFIX) {
    return `/${normalized}`;
  }
  return `${ROUTE_PREFIX}/${normalized}`;
}

function findOverrideForRoute(upstreamPath, route) {
  const candidates = new Set();
  if (typeof upstreamPath === 'string') {
    const trimmed = upstreamPath.trim();
    if (trimmed) {
      candidates.add(trimmed);
      candidates.add(trimmed.startsWith('/') ? trimmed : `/${trimmed}`);
    }
  }
  if (typeof route === 'string') {
    const trimmedRoute = route.trim();
    if (trimmedRoute) {
      candidates.add(trimmedRoute);
      candidates.add(trimmedRoute.replace(/^\/+/, ''));
      if (ROUTE_PREFIX && trimmedRoute.startsWith(`${ROUTE_PREFIX}/`)) {
        const withoutPrefix = trimmedRoute.slice(ROUTE_PREFIX.length);
        const withoutPrefixNormalized = withoutPrefix.replace(/^\/+/, '');
        if (withoutPrefix) candidates.add(withoutPrefix);
        if (withoutPrefixNormalized) {
          candidates.add(withoutPrefixNormalized);
          candidates.add(`/${withoutPrefixNormalized}`);
        }
      }
    }
  }
  for (const key of candidates) {
    if (Object.prototype.hasOwnProperty.call(upstreamOverrides, key)) {
      return upstreamOverrides[key];
    }
  }
  return null;
}

function buildUpstreamUrl(base, route, overrideValue) {
  if (overrideValue && /^https?:\/\//i.test(overrideValue)) {
    return overrideValue;
  }
  if (overrideValue) {
    const relative = overrideValue.startsWith('/') ? overrideValue : `/${overrideValue}`;
    return `${base}${relative}`;
  }
  return `${base}${route}`;
}

// Ensure log directory exists
const LOG_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'requests.ndjson');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const DEFAULT_LOG_LIMIT = 200;
const MAX_LOG_LIMIT = 1000;

function logRequest(id, route, body, upstreamUrl) {
  const entry = {
    ts: new Date().toISOString(),
    id,
    type: 'request',
    route,
    ...(upstreamUrl ? { target: upstreamUrl } : {}),
    body,
  };
  const line = JSON.stringify(entry) + '\n';
  fs.appendFile(LOG_FILE, line, (err) => {
    if (err) console.error('Failed to write log:', err);
  });
  console.log(`\n=== ${route} @ ${entry.ts} ===`);
  if (upstreamUrl) {
    console.log(`[target] ${upstreamUrl}`);
  }
  console.log(JSON.stringify(body, null, 2));
}

async function loadRecentLogs(limit = DEFAULT_LOG_LIMIT) {
  const effectiveLimit = Math.min(Math.max(1, Number(limit) || DEFAULT_LOG_LIMIT), MAX_LOG_LIMIT);
  try {
    const data = await fsp.readFile(LOG_FILE, 'utf8');
    const lines = data.split(/\r?\n/).filter(Boolean);
    const recent = lines.slice(-effectiveLimit);
    return recent.map((line) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        return { ts: new Date().toISOString(), type: 'parse_error', raw: line, error: err.message };
      }
    });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function logResponseFull(id, route, status, headers, bodyText, summaryText) {
  // Extract tool calls for better human readability in logs
  const toolCalls = extractToolCalls(bodyText, headers);
  const entry = {
    ts: new Date().toISOString(),
    id,
    type: 'response',
    route,
    status,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    ...(LOG_RAW_BODY ? { body: bodyText } : {}),
    content: summaryText,
  };
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.error('Failed to write response log:', err);
  });
}

function extractContentFromJson(json) {
  try {
    if (!json || typeof json !== 'object') return '';
    // chat/completions (non-stream)
    if (Array.isArray(json.choices) && json.choices.length) {
      const parts = [];
      for (const c of json.choices) {
        if (c && c.message && typeof c.message.content === 'string') parts.push(c.message.content);
        else if (typeof c.text === 'string') parts.push(c.text);
      }
      if (parts.length) return parts.join('');
    }
    // responses API convenience
    if (Array.isArray(json.output_text) && json.output_text.length) {
      return json.output_text.join('');
    }
    if (typeof json.output_text === 'string') return json.output_text;
    // Some responses use top-level "content" as string
    if (typeof json.content === 'string') return json.content;
    // responses API output items
    if (Array.isArray(json.output)) {
      const texts = [];
      for (const item of json.output) {
        if (item && (item.type === 'output_text' || item.type === 'message') && typeof item.text === 'string') texts.push(item.text);
        else if (item && item.content && Array.isArray(item.content)) {
          for (const p of item.content) {
            if (p && typeof p.text === 'string') texts.push(p.text);
          }
        }
      }
      if (texts.length) return texts.join('');
    }
  } catch (_) {}
  return '';
}

function extractContentFromSSE(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const acc = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const evt = JSON.parse(payload);
      // chat/completions streaming
      if (evt && Array.isArray(evt.choices)) {
        for (const c of evt.choices) {
          if (c && c.delta && typeof c.delta.content === 'string') acc.push(c.delta.content);
          else if (typeof c.text === 'string') acc.push(c.text);
        }
        continue;
      }
      // responses API streaming
      if (evt && typeof evt === 'object') {
        // convenience: many events include { type, delta: { type: 'output_text.delta', text } }
        if (evt.delta && typeof evt.delta.text === 'string') {
          acc.push(evt.delta.text);
          continue;
        }
        // Fallback: walk object to collect all string values named 'text' under 'delta'
        const stack = [];
        if (evt.delta && typeof evt.delta === 'object') stack.push(evt.delta);
        while (stack.length) {
          const cur = stack.pop();
          for (const k of Object.keys(cur)) {
            const v = cur[k];
            if (typeof v === 'string' && (k === 'text' || k === 'content')) acc.push(v);
            else if (v && typeof v === 'object') stack.push(v);
          }
        }
      }
    } catch (_) {
      // ignore malformed SSE chunk
    }
  }
  return acc.join('');
}

function extractContent(bodyText, headers) {
  try {
    const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    if (ct.includes('text/event-stream') || /^data:/m.test(bodyText)) {
      return extractContentFromSSE(bodyText);
    }
    // Try JSON parsing
    try {
      const json = JSON.parse(bodyText);
      const c = extractContentFromJson(json);
      if (c) return c;
    } catch (_) {}
  } catch (_) {}
  return '';
}

// Extract tool calls from final JSON objects
function extractToolCallsFromJson(json) {
  try {
    const calls = [];
    // chat/completions final message.tool_calls
    if (Array.isArray(json.choices)) {
      for (const c of json.choices) {
        const msg = c && c.message;
        const tcs = msg && Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
        for (const tc of tcs) {
          const fn = tc.function || tc;
          const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
          const args = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;
          if (name || args) calls.push({ name, arguments: args });
        }
      }
    }
    // responses API: attempt best-effort extraction if present under top-level "tool_calls"
    if (Array.isArray(json.tool_calls)) {
      for (const tc of json.tool_calls) {
        const fn = tc.function || tc;
        const name = fn && typeof fn.name === 'string' ? fn.name : undefined;
        const args = fn && typeof fn.arguments === 'string' ? fn.arguments : undefined;
        if (name || args) calls.push({ name, arguments: args });
      }
    }
    return calls;
  } catch (_) { return []; }
}

// Extract tool calls from an SSE stream by accumulating delta.tool_calls fragments
function extractToolCallsFromSSE(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const accByIndex = new Map(); // index -> { name, arguments }
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let evt; try { evt = JSON.parse(payload); } catch { continue; }
    const choices = evt && Array.isArray(evt.choices) ? evt.choices : [];
    for (const ch of choices) {
      const delta = ch && ch.delta;
      if (!delta || !Array.isArray(delta.tool_calls)) continue;
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        const entry = accByIndex.get(idx) || { name: '', arguments: '' };
        const fn = tc.function || {};
        if (typeof fn.name === 'string' && !entry.name) entry.name = fn.name;
        if (typeof fn.arguments === 'string' && fn.arguments) entry.arguments += fn.arguments;
        accByIndex.set(idx, entry);
      }
    }
  }
  return Array.from(accByIndex.values()).filter(e => e.name || e.arguments);
}

function extractToolCalls(bodyText, headers) {
  try {
    const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    if (ct.includes('text/event-stream') || /^data:/m.test(bodyText)) {
      return extractToolCallsFromSSE(bodyText);
    }
    try {
      const json = JSON.parse(bodyText);
      return extractToolCallsFromJson(json);
    } catch (_) { /* not JSON */ }
  } catch (_) {}
  return [];
}

async function proxyPost(req, res, upstreamPath) {
  const normalizedPath = typeof upstreamPath === 'string' ? upstreamPath.trim().replace(/^\/+/, '') : '';
  const route = buildRoutePath(normalizedPath);
  const overrideValue = findOverrideForRoute(upstreamPath, route);
  const upstreamUrl = buildUpstreamUrl(API_BASE, route, overrideValue);
  const reqId = (crypto.randomUUID && typeof crypto.randomUUID === 'function')
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const body = req.body || {};

  logRequest(reqId, route, body, upstreamUrl);

  const headers = {
    'Content-Type': 'application/json',
  };

  if (ALLOW_CLIENT_AUTH) {
    const clientAuth = req.header('Authorization');
    if (clientAuth) headers['Authorization'] = clientAuth;
    const clientOrg = req.header('OpenAI-Organization');
    if (clientOrg) headers['OpenAI-Organization'] = clientOrg;
    const clientProject = req.header('OpenAI-Project');
    if (clientProject) headers['OpenAI-Project'] = clientProject;
    const clientBeta = req.header('OpenAI-Beta');
    if (clientBeta) headers['OpenAI-Beta'] = clientBeta;
  }

  if (!headers['Authorization'] && UPSTREAM_API_KEY) {
    headers['Authorization'] = `Bearer ${UPSTREAM_API_KEY}`;
  }

  // Decide whether to inject org/project headers from env
  const token = (headers['Authorization'] || '').replace(/^Bearer\s+/i, '');
  const isProjectKey = /^sk-proj-/.test(token);

  // For project-scoped keys, org/project headers are not required and usually ignored.
  // Only inject if explicitly forced or if using user-scoped keys.
  const shouldInjectOrgProject = (!isProjectKey || FORCE_OPENAI_HEADERS);

  if (shouldInjectOrgProject) {
    if (!headers['OpenAI-Organization'] && OPENAI_ORG) {
      headers['OpenAI-Organization'] = OPENAI_ORG;
    }
    if (!headers['OpenAI-Project'] && OPENAI_PROJECT) {
      headers['OpenAI-Project'] = OPENAI_PROJECT;
    }
  }

  // Beta header is opt-in and harmless if unused
  if (!headers['OpenAI-Beta'] && OPENAI_BETA) {
    headers['OpenAI-Beta'] = OPENAI_BETA;
  }

  if (!headers['Authorization'] && /^https?:\/\/api\.openai\.com(?:$|\/)/.test(API_BASE)) {
    res.status(401).json({ error: 'No Authorization header and no UPSTREAM_API_KEY set.' });
    return;
  }

  try {
    if (overrideValue) {
      console.log('[proxy] Forwarding to override', upstreamUrl);
    } else {
      console.log('[proxy] Forwarding to', upstreamUrl);
    }
    const upstreamResp = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    res.status(upstreamResp.status);

    const hopByHop = new Set([
      'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
      'te', 'trailers', 'transfer-encoding', 'upgrade'
    ]);

    upstreamResp.headers.forEach((value, key) => {
      if (!hopByHop.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // Prepare plain headers map for logging
    const plainHeaders = {};
    upstreamResp.headers.forEach((value, key) => { plainHeaders[key] = value; });

    if (!upstreamResp.body) {
      const text = await upstreamResp.text();
      const content = extractContent(text, plainHeaders);
      logResponseFull(reqId, route, upstreamResp.status, plainHeaders, text, content);
      res.send(text);
      return;
    }

    // Handle both WHATWG ReadableStream (Node fetch) and Node Readable (node-fetch)
    try {
      const body = upstreamResp.body;
      const isNodeReadable = typeof body.pipe === 'function';

      // Collect chunks while streaming to client so we can log a single entry
      const collected = [];

      if (isNodeReadable) {
        body.on('error', (err) => {
          console.error('Upstream stream error:', err);
          if (!res.headersSent) res.status(502);
          res.end();
        });
        body.on('data', (chunk) => {
          try { collected.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); } catch (e) { /* ignore logging errors */ }
        });
        body.on('end', () => {
          try {
            const text = Buffer.concat(collected).toString('utf8');
            const content = extractContent(text, plainHeaders);
            logResponseFull(reqId, route, upstreamResp.status, plainHeaders, text, content);
          } catch (e) { /* ignore logging errors */ }
        });
        body.pipe(res);
      } else if (typeof body.getReader === 'function') {
        // Manually pump WHATWG ReadableStream to the response (works across Node versions)
        const reader = body.getReader();
        const collectedWeb = [];
        (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                const buf = Buffer.from(value);
                try { collectedWeb.push(buf); } catch (e) { /* ignore */ }
                res.write(buf);
              }
            }
            try {
              const text = Buffer.concat(collectedWeb).toString('utf8');
              const content = extractContent(text, plainHeaders);
              logResponseFull(reqId, route, upstreamResp.status, plainHeaders, text, content);
            } catch (e) { /* ignore */ }
            res.end();
          } catch (err) {
            console.error('Upstream stream error:', err);
            if (!res.headersSent) res.status(502).end();
            else res.end();
          }
        })();
      } else {
        // Fallback: buffer and send
        const buf = Buffer.from(await upstreamResp.arrayBuffer());
        try {
          const text = buf.toString('utf8');
          const content = extractContent(text, plainHeaders);
          logResponseFull(reqId, route, upstreamResp.status, plainHeaders, text, content);
        } catch (e) { /* ignore */ }
        res.end(buf);
      }
    } catch (streamErr) {
      console.error('Streaming proxy error:', streamErr);
      if (!res.headersSent) res.status(502).end();
      else res.end();
    }
  } catch (err) {
    console.error('Proxy error:', err);
    if (!res.headersSent) res.status(502).json({ error: 'Proxy failed', details: String(err) });
    else res.end();
  }
}

app.get('/health', (_req, res) => res.json({ ok: true, apiBase: API_BASE, namespace: API_NAMESPACE }));

app.get('/logs/data', async (req, res) => {
  try {
    const { limit } = req.query;
    const entries = await loadRecentLogs(limit);
    res.json({ entries });
  } catch (err) {
    console.error('[logs] Failed to read log file:', err);
    res.status(500).json({ error: 'Failed to read logs', detail: err.message });
  }
});

app.get('/logs', (_req, res) => {
  const html = `<!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Proxy Logs</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; margin: 0; background: #111; color: #f5f5f5; }
      header { padding: 12px 16px; background: #1d1d1d; display: flex; gap: 12px; align-items: baseline; }
      header h1 { margin: 0; font-size: 1.1rem; }
      main { padding: 16px; }
      textarea { width: 100%; height: 80vh; background: #000; color: #0f0; border: 1px solid #333; padding: 12px; box-sizing: border-box; font-size: 0.9rem; }
      label { font-size: 0.85rem; color: #ccc; }
      input { background: #222; border: 1px solid #444; color: #f5f5f5; padding: 4px 6px; margin-left: 6px; width: 70px; }
    </style>
  </head>
  <body>
    <header>
      <h1>LLM Proxy Logs</h1>
      <label>Dernières entrées: <input id="limit" type="number" min="1" max="${MAX_LOG_LIMIT}" value="${DEFAULT_LOG_LIMIT}" /></label>
      <span id="status">Chargement…</span>
    </header>
    <main>
      <textarea id="log" readonly></textarea>
    </main>
    <script>
      const statusEl = document.getElementById('status');
      const logEl = document.getElementById('log');
      const limitInput = document.getElementById('limit');
      const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

      async function fetchLogs() {
        const limit = clamp(parseInt(limitInput.value, 10) || ${DEFAULT_LOG_LIMIT}, 1, ${MAX_LOG_LIMIT});
        const params = new URLSearchParams({ limit: String(limit) });
        try {
          const resp = await fetch('/logs/data?' + params.toString(), { cache: 'no-store' });
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          const data = await resp.json();
          const lines = (data.entries || []).map(entry => JSON.stringify(entry));
          logEl.value = lines.join('\n');
          logEl.scrollTop = logEl.scrollHeight;
          const now = new Date().toLocaleTimeString();
          statusEl.textContent = 'Mis à jour: ' + now;
        } catch (err) {
          statusEl.textContent = 'Erreur: ' + err.message;
        }
      }

      limitInput.addEventListener('change', fetchLogs);
      setInterval(fetchLogs, 4000);
      fetchLogs();
    </script>
  </body>
  </html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

const PROXY_PREFIX = ROUTE_PREFIX || '';

app.post(`${PROXY_PREFIX}/chat/completions`, (req, res) => proxyPost(req, res, 'chat/completions'));
app.post(`${PROXY_PREFIX}/responses`, (req, res) => proxyPost(req, res, 'responses'));

app.post(`${PROXY_PREFIX}/:first`, (req, res) => proxyPost(req, res, req.params.first));
app.post(`${PROXY_PREFIX}/:first/:second`, (req, res) => proxyPost(req, res, `${req.params.first}/${req.params.second}`));

function startListening(port, triesLeft = 10) {
  const server = app.listen(port, () => {
    console.log(`LLM logging proxy listening on http://localhost:${port}`);
    if (port !== PORT) {
      console.log(`[port] ${PORT} was busy, auto-switched to ${port}`);
    }
    console.log(`Upstream base: ${API_BASE}`);
    console.log(`Proxy namespace: ${API_NAMESPACE || '(root)'}`);
    console.log(`Auth mode: ${ALLOW_CLIENT_AUTH ? 'pass-through client Authorization' : (UPSTREAM_API_KEY ? 'UPSTREAM_API_KEY' : 'none')}`);
    console.log(`Logging to: ${LOG_FILE}`);
  });
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && AUTO_PORT && triesLeft > 0) {
      const nextPort = port + 1;
      console.warn(`[server] Port ${port} in use. Retrying on ${nextPort}...`);
      setTimeout(() => startListening(nextPort, triesLeft - 1), 150);
      return;
    }
    console.error('[server] error:', err);
    process.exit(1);
  });
}

startListening(PORT);
