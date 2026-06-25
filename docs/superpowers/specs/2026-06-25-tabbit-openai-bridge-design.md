# Tabbit OpenAI Bridge Design

**Goal:** Build a Chrome extension plus local bridge that exposes `POST /v1/chat/completions` and forwards requests to an authenticated Tabbit session.

**Architecture:** A Manifest V3 Chrome extension captures the current Tabbit session state from the logged-in browser context and syncs it to a local Node bridge. The bridge listens on `127.0.0.1`, exposes an OpenAI-compatible chat completions endpoint, converts each OpenAI request into a Tabbit chat completion request, and translates Tabbit's SSE response back into OpenAI streaming or non-streaming output.

**Tech Stack:** Chrome Extension Manifest V3, TypeScript, Node.js `http` server, SSE parsing/rewriting, minimal filesystem-based config.

---

## Scope

This first version supports:

- `POST /v1/chat/completions`
- streaming and non-streaming responses
- a single active Tabbit session bound to the local bridge

This first version does not include:

- `GET /v1/models`
- embeddings, images, or tool calls
- account management or multi-session routing

## Components

### 1. Chrome extension

Responsibilities:

- detect when the user is on a Tabbit session page
- extract the active `chat_session_id` from the page URL
- read the minimum session cookies needed for authenticated calls
- sync that state to the local bridge

The extension does not expose an API to other apps. It only feeds the bridge.

### 2. Local bridge

Responsibilities:

- listen on `127.0.0.1:<port>`
- accept OpenAI-style requests from any local client
- keep the latest synced Tabbit session state in memory
- call `https://web.tabbit.ai/api/v1/chat/completion`
- rewrite Tabbit responses into OpenAI-compatible JSON or SSE

The bridge is the only process external software talks to.

## Data Flow

1. User opens and logs into `https://web.tabbit.ai/session/<id>`.
2. Extension reads the session id from the URL and syncs cookies plus session metadata to the bridge.
3. External software sends `POST /v1/chat/completions` to the local bridge.
4. Bridge maps the OpenAI payload into the Tabbit request shape.
5. Bridge forwards the authenticated request to Tabbit.
6. Bridge streams or returns the result in OpenAI format.

## Request Mapping

OpenAI request fields used in v1:

- `model` -> Tabbit `selected_model`
- `messages` -> Tabbit prompt content, using the latest user turn as the outgoing message body
- `stream` -> controls SSE passthrough
- `temperature`, `top_p`, `max_tokens` -> forwarded when present and supported

The bridge treats the active Tabbit session as the backing conversation. One bridge instance maps to one active browser session.

## Response Mapping

Non-streaming:

- return a standard OpenAI chat completion object
- synthesize `id`, `object`, `created`, `model`, and `choices`

Streaming:

- forward chunks as OpenAI SSE events
- preserve incremental assistant text deltas
- send `[DONE]` at the end

If Tabbit returns an auth error or session expiry, the bridge surfaces a normal OpenAI-style error object.

## Configuration

Minimum config:

- `port`
- `tabbitOrigin` defaulting to `https://web.tabbit.ai`
- `sessionSyncSecret` for local-only sync requests from the extension

Session cookies and token material are never hardcoded into source files.

## Validation

Tests and checks should cover:

- parsing Tabbit session ids from session URLs
- storing and replacing synced session state
- translating one OpenAI request into one Tabbit request
- SSE chunk rewriting
- non-streaming JSON rewriting
- auth-missing and session-missing error paths

## Risks

- The bridge is bound to one active Tabbit session, so it is not a full multi-conversation OpenAI backend.
- If Tabbit changes its request schema, the bridge may need a small adapter update.
- Local sync must keep secrets out of logs and out of committed files.
