# Codex Proxy — OpenAI-Compatible Logging Proxy (Node/Express)

A tiny Node/Express proxy that forwards OpenAI‑compatible API requests while writing rich NDJSON logs for easy analysis. It supports standard JSON and streaming (SSE) responses and is handy for tracing prompts, parameters, and tool/function calls.

## Features

- OpenAI‑compatible proxy to any API base (default `https://api.openai.com/v1`).
- Logs every request/response to `logs/requests.ndjson` (one JSON per line).
- Streams upstream SSE to the client while also logging the full response once.
- Extracts assistant content into a concise `content` field (best‑effort).
- Extracts tool/function calls into a `tool_calls` array for human‑readable auditing.
- Simple CORS for browser clients; health endpoint at `/health`.

## Requirements

- Node.js 18+ recommended. If you use Node <18, the proxy dynamically polyfills `fetch` via `node-fetch@3` (must be installed).

## Quick Start

1) Install dependencies

```bash
npm i express dotenv
# Optional on Node <18
npm i node-fetch@3
```

2) Create a `.env` file (example)

```ini
PORT=5000
API_BASE=https://api.openai.com/v1
UPSTREAM_API_KEY=sk-...
ALLOW_CLIENT_AUTH=false
# Optional header helpers
OPENAI_ORG=
OPENAI_PROJECT=
OPENAI_BETA=
FORCE_OPENAI_HEADERS=false
# Logging
LOG_RAW_BODY=true
```

3) Run the proxy

```bash
node server.js
```

4) Verify it’s up

```bash
curl -sS http://localhost:5000/health
```

## Usage

Proxied endpoints (more can be added easily):
- `POST /v1/chat/completions`
- `POST /v1/responses`
- Catch‑all passthrough: `POST /v1/:first`

Examples:

```bash
# Non‑stream example
curl -sS -X POST \
  http://localhost:5000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $OPENAI_API_KEY' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hello"}]}'

# Stream example (SSE)
curl -N -sS -X POST \
  http://localhost:5000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer $OPENAI_API_KEY' \
  -d '{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

## Logging

- Log file lives at: `logs/requests.ndjson` (relative to `server.js`).
- One NDJSON line per event.
- Two event types: `request` and `response`.

Request entry shape (example):

```json
{
  "ts": "2025-09-16T12:34:56.789Z",
  "id": "<uuid>",
  "type": "request",
  "route": "/v1/chat/completions",
  "body": { "model": "...", "messages": [...] }
}
```

Response entry shape (example):

```json
{
  "ts": "2025-09-16T12:34:57.123Z",
  "id": "<uuid>",
  "type": "response",
  "route": "/v1/chat/completions",
  "status": 200,
  "tool_calls": [ { "name": "shell", "arguments": "{\"command\":[\"bash\",...]}" } ],
  "body": "... full upstream body text (optional) ...",
  "content": "... best‑effort extracted assistant text ..."
}
```

Notes:
- `tool_calls`: extracted from final messages (`choices[].message.tool_calls`) or reconstructed from streaming deltas (`choices[].delta.tool_calls`). `arguments` is the raw string (may be JSON).
- `body` presence is controlled by `LOG_RAW_BODY` (default `true`). Set `LOG_RAW_BODY=false` to omit raw bodies from logs.
- Response headers are intentionally not logged.

Tail the log:

```bash
tail -f logs/requests.ndjson
```

## Configuration

Environment variables (via `.env`):

- `PORT` (number): HTTP port (default `5000`).
- `AUTO_PORT` (bool): If used in your environment, can auto‑select a free port (default `true`).
- `API_BASE` (string): Upstream base, e.g. `https://api.openai.com/v1`.
- `UPSTREAM_API_KEY` (string): Upstream API key used if client does not send `Authorization`.
- `ALLOW_CLIENT_AUTH` (bool): If `true`, forwards client `Authorization` and `OpenAI-*` headers.
- `OPENAI_ORG`, `OPENAI_PROJECT` (strings): Injected when appropriate; project‑scoped keys typically don’t require these.
- `OPENAI_BETA` (string): Optional beta header to pass through (harmless if unused).
- `FORCE_OPENAI_HEADERS` (bool): Force inject org/project even with project‑scoped keys.
- `LOG_RAW_BODY` (bool): Include raw body text in response logs (default `true`).

## Behavior Notes

- CORS: Allows `*` origin, common OpenAI headers, and `GET, POST, OPTIONS`.
- Auth fallback: If no client `Authorization` and no `UPSTREAM_API_KEY`, OpenAI base requests return `401` with a helpful message.
- Streaming: Pipes upstream body to client; collects chunks to log a single complete response at the end.
- Fetch polyfill: On Node <18, `node-fetch@3` is required and used dynamically.

## Troubleshooting

- “Log file is empty”: Make sure you’re looking at the correct path for the running proxy (e.g., this repo’s `logs/requests.ndjson`).
- Permission/port issues: Switch ports (`PORT`) or free the port in use.
- `401 Unauthorized`: Provide an API key via client header or `UPSTREAM_API_KEY`.
- Large inputs: Upstream may reject over‑limit contexts; check `status` and `body` error messages in logs.

## Extend

- Add routes: Wire additional OpenAI‑compatible endpoints to `proxyPost(...)` in `server.js`.
- Custom extraction: Adjust `extractContent*` or `extractToolCalls*` helpers to fit new models/APIs.

---

Happy debugging and prompt‑tracing!

