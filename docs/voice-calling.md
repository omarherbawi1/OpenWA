# Linked-device voice calling

OpenWA supports one-to-one WhatsApp voice calls through the optional `zapo`
engine. This is a linked-device implementation; it does not use Meta Cloud
Business Calling and cannot add media support to existing whatsapp-web.js or
Baileys sessions.

## Requirements

- Set `ENGINE_TYPE=zapo`.
- Link every Zapo session as a new companion device. Its state is stored at
  `<ZAPO_AUTH_DIR>/<session-name>/state.sqlite`.
- Allow outbound WebSocket/TLS and UDP traffic to WhatsApp relay endpoints.
- Serve the dashboard from HTTPS or localhost so browsers permit microphone
  capture.
- Set both `VITE_API_URL` and `VITE_WS_URL` when the dashboard and API use
  different origins, and include the dashboard origin in `CORS_ORIGINS`.
- Proxy `/api` and `/socket.io` (including WebSocket upgrades) when OpenWA is
  behind a reverse proxy. The Socket.IO transport path remains `/socket.io`;
  `/events` and `/calls` are namespaces.

The engine loads `zapo-js`, `@zapo-js/voip`, `@zapo-js/store-sqlite`,
`@roamhq/wrtc`, `libmlow-wasm`, `ws`, and `socks-proxy-agent`. Before linking,
an admin can verify the complete import stack with
`GET /api/plugins/zapo/health`; CI runs the same native-runtime import smoke.

The supported server targets are Node.js 22 on glibc-based Linux x64/arm64,
macOS x64/arm64, and Windows x64 where `@roamhq/wrtc` publishes a prebuilt
binary. Alpine/musl and other architectures require unsupported native source
builds. Browser audio requires a current Chrome, Firefox, or Safari in a secure
context.

Zapo auth is not compatible with whatsapp-web.js or Baileys auth. Account
passkey approval is not available in the headless engine; affected pairing
attempts fail with an explicit session error instead of hanging.

## Call control API

All routes are scoped to the session and use the normal `X-API-Key` header.
Mutations require an `OPERATOR` or `ADMIN` key.

| Action              | Method and route                                                              |
| ------------------- | ----------------------------------------------------------------------------- |
| List calls          | `GET /api/sessions/:sessionId/calls`                                          |
| Read a call         | `GET /api/sessions/:sessionId/calls/:callId`                                  |
| Start an audio call | `POST /api/sessions/:sessionId/calls` with `{ "peerId": "15551234567@c.us" }` |
| Accept              | `POST /api/sessions/:sessionId/calls/:callId/accept`                          |
| Reject              | `POST /api/sessions/:sessionId/calls/:callId/reject`                          |
| End                 | `POST /api/sessions/:sessionId/calls/:callId/end`                             |
| Mute/unmute         | `PATCH /api/sessions/:sessionId/calls/:callId/mute` with `{ "muted": true }`  |

Call snapshots use the states `initiating`, `ringing`, `incoming_ringing`,
`connecting`, `active`, `on_hold`, and `ended`.

## Events and webhooks

The `/events` Socket.IO namespace and webhooks expose `call.incoming`,
`call.state`, `call.ended`, and `call.error`. These are control-plane JSON
events; raw audio is never included.

## Live audio protocol

Connect Socket.IO to `/calls` using `auth.apiKey` or the `X-API-Key` header.
The key is checked again against the requested session when joining.

1. Emit `join-call` with `{ sessionId, callId }` and wait for the acknowledgement
   or `joined` event.
2. Send microphone frames as little-endian, normalized mono `Float32` PCM in
   `call:uplink`.
3. Read the same PCM format from `call:downlink`.
4. Honor each uplink acknowledgement and `backpressure` payload. A paused sender
   must wait for `retryAfterMs` and probe again; it resumes only after the server
   reports `paused: false`.
5. Emit `leave-call` before disconnecting. `call-ended` closes the media flow
   automatically.

The fixed sample rate is 16 kHz. Frames may contain at most one second of audio.
Only one joined socket owns a call's microphone at a time; other authorized
sockets may listen but receive `UPLINK_NOT_OWNER` if they try to inject audio.
API-key revocation, session stop/replacement, and call termination all evict
the media flow.

The dashboard implements capture, streaming resampling, bounded playback,
backpressure, mute, and resource cleanup. It uses an `AudioWorklet` where
available and falls back to `ScriptProcessorNode`.

## Current scope

- One-to-one audio calls only; video and group calls are not exposed.
- Zapo supports lifecycle, plain text, chat list/history, number lookup,
  read/unread/delete-chat, typing state, and voice calls. Other messaging
  methods return HTTP 501; see the
  [engine capability matrix](engine-capability-matrix.md).
- HTTP(S) and SOCKS session proxies are applied to Zapo's linked-device
  WebSocket signaling. Voice media still connects directly to WhatsApp relay
  endpoints and therefore requires outbound UDP; no inbound UDP port mapping
  is required.
- Because this relies on an unofficial linked-device protocol, WhatsApp
  protocol changes can require a Zapo update.
