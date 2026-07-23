# Branch notes: full voice calling

## Live validation follow-up

- Task: exercise the complete linked-account call path against
  `+972594598388`, including real signaling, bidirectional browser audio,
  incoming/outgoing lifecycle, and teardown.
- The requested `test` branch still does not exist locally or on `origin` after
  `git fetch origin`; the only meaningful target is the implemented voice
  branch. `feature/live-voice-validation-04e3` therefore starts from refreshed
  `origin/feature/full-voice-calling-04e3`.
- No result should be called live-validated unless the linked Zapo session and
  remote phone actually exchange a call and audio; mocked media remains only a
  regression safety net.
- Runtime inspection found only the local `voice-readiness` session in
  `qr_ready` with `phone: null`; logs continued emitting pairing QRs and never
  reached an authenticated/ready transition. No real call was attempted because
  this engine cannot dial before a session is linked.
- Resuming live validation requires either scanning this workspace's active Zapo
  QR or supplying the URL, API key, and session id of the deployment where the
  new number was linked. A person or auto-answer endpoint must also answer
  `+972594598388` and exchange audio to prove both media directions.
- After the user reported another link, both a fresh `GET /api/sessions` and a
  hard-refreshed dashboard still showed only `voice-readiness` in `qr_ready`
  with no phone identity. The follow-up call validation therefore remains
  unexecuted; the user subsequently requested consolidation of this branch into
  `main`.
- At the user's explicit request, the full voice and validation branches were
  merged conflict-free into `main`; the merged backend voice regressions,
  dashboard units, TypeScript check, and native runtime import smoke passed.
  Both merged voice feature branches were then deleted locally and from
  `origin`. The unrelated environment-setup branch was not touched.

## Task

- Investigate and implement end-to-end WhatsApp voice calling, including outgoing
  and incoming calls with bidirectional audio.

## Base

- The requested `test` branch does not exist locally or on `origin`.
- This branch was created from the refreshed `origin/main` tip instead:
  `feature/full-voice-calling-04e3`.

## Running log

- Started by auditing the supported capabilities of each messaging engine and its
  upstream client library before defining an API or claiming media support.
- `whatsapp-web.js` 1.34.7 exposes an incoming-call event, `Call.reject()`,
  and call-link creation. It exposes no call accept/start/end API or audio stream.
- Baileys 7.0.0-rc13 exposes call lifecycle events, `rejectCall()`, call-link
  creation, and call privacy settings. It exposes no usable VoIP media transport;
  upstream maintainers explicitly reject signaling-only patches as incomplete VoIP.
- OpenWA's existing `MessageType: "call"` is post-call log metadata, not a live
  call. There is currently no call controller, call event plane, WebRTC/SRTP media
  stack, or live-call dashboard.
- Meta's supported alternative is the WhatsApp Business Calling API. It requires a
  separate Cloud API business phone number, an app subscribed to call webhooks,
  calling enablement, account eligibility, and either Graph/WebRTC or SIP media.
  It does not add calling to existing linked-device sessions.
- The user explicitly declined Meta Cloud Calling and requested full linked-device
  voice. A maintained TypeScript implementation became available in 2026:
  `zapo-js` plus `@zapo-js/voip`. It implements incoming/outgoing one-to-one call
  signaling, MLow audio, SRTP, relay transport, and live 16 kHz PCM in both
  directions.
- Added a third `zapo` engine instead of pretending Baileys auth can be reused.
  Zapo owns its own linked-device session and SQLite Signal/auth store.
- Added engine-neutral voice-call types, REST call controls, lifecycle webhooks and
  `/events` notifications, an authenticated binary `/calls` Socket.IO media plane,
  and a dashboard call panel with microphone capture/resampling and audio playback.
- Reconciled the dashboard/backend media protocol (`join-call`, `leave-call`,
  `joined`, `backpressure`, `call-ended`, `PATCH .../mute`) and made uplink
  delivery acknowledgement-driven. Backpressure now drops stale capture, waits
  for the engine queue, and resumes only after a successful probe.
- Hardened lifecycle cleanup: engine stop/replacement synthesizes terminal call
  snapshots, broadcasts `call.ended`, and evicts media rooms. API-key eviction and
  gateway shutdown also release media resources.
- Enforced one microphone owner per call room so another authorized dashboard can
  listen but cannot inject competing PCM.
- Removed the adapter-level Zapo reconnect loop. Zapo retains ownership of its
  forced-login stream-control reconnect; `SessionService` owns service-unavailable
  backoff, preventing competing connect attempts.
- Added explicit passkey/pairing readiness failures, client-version recovery,
  a direct `ws` runtime dependency, dependency-aware engine health, and minimal
  SQLite-backed `getChats`/`getChatHistory` support for the dashboard host page.
- Added `docs/voice-calling.md`, README/engine documentation, and a changelog
  entry describing setup, REST/events/media contracts, security, and limitations.
- Live Socket.IO testing exposed connection-hook races in both `/calls` and
  `/events`: clients can emit `join-call`/`subscribe` as soon as Socket.IO
  acknowledges the connection, before asynchronous API-key validation finishes.
  Both gateways now preserve the handshake credential synchronously and still
  perform fresh session-scoped validation for each join/subscription. Regression
  tests cover immediate joins and all four call-event subscriptions.
- The pre-connection readiness pass hardened Zapo lifecycle ownership: disconnect,
  logout, remote unlink, and superseded initialization now detach stale clients,
  close SQLite/proxy resources, and prevent late callbacks from mutating a new
  lifecycle. Voice events are serialized so async LID-to-phone resolution cannot
  reorder state or expose inconsistent peer IDs.
- Call mutations and media now require the live engine to still own the call.
  Media ownership follows the exact engine instance, stale snapshots are pruned,
  and terminal notifications/teardown are idempotent across duplicate or
  state-only ended events.
- Dashboard call media cleanup now releases superseded microphone/audio contexts,
  removes Socket.IO manager listeners, clears queued playback on disconnect, and
  safely handles malformed backpressure delays. Call selection drops terminal
  calls and prioritizes unseen incoming calls.
- Added a native Zapo dependency import smoke and an isolated
  `ENGINE_TYPE=zapo` Nest boot e2e gate. Compose forwards `ZAPO_AUTH_DIR`, and
  deployment/API docs now cover native platform support, secure browser contexts,
  split origins, reverse proxies, and the complete call media protocol.

## Validation target

- A complete implementation must prove outgoing and incoming call signaling,
  lifecycle events, and bidirectional live audio against WhatsApp—not merely expose
  API methods or mock call events.

## Validation performed

- The full CI-equivalent suite passes: backend lint (four pre-existing Baileys
  warnings, zero errors), full-program TypeScript, formatting, version/OpenAPI
  checks, Nest build, 191 Jest suites / 2,470 tests, and 10 e2e suites / 54 tests.
  The PostgreSQL-only unit suite and five tests skip in the SQLite job; three
  e2e cases remain explicit todos.
- Dashboard lint has two pre-existing Fast Refresh warnings and zero errors;
  i18n parity, production build, and all 109 dashboard unit tests pass.
- `npm audit --audit-level=critical` passes; npm reports lower-severity findings
  in the existing dependency tree.
- The dedicated runtime smoke imports Zapo core, SQLite, VoIP, native WebRTC,
  MLow WASM, WebSocket, and SOCKS proxy packages. The isolated Nest boot test
  selects Zapo and confirms its voice/persistent-auth features.
- A local `ENGINE_TYPE=zapo` process reported the complete dependency stack
  healthy, created and started a session, reached `qr_ready`, and produced a
  valid pairing QR through both REST and the dashboard.
- Live REST and Socket.IO checks verified unlinked-call rejection, immediate
  authenticated `/calls` joins returning `CALL_NOT_FOUND` rather than a false
  auth failure, unauthorized client rejection, and immediate `/events`
  subscriptions for `call.incoming`, `call.state`, `call.ended`, and `call.error`.
- Manual browser testing verified login, session display, live QR modal,
  navigation, and a clean console. The Chats page correctly gates the call panel
  until a session is linked.

## External validation still required

- No WhatsApp account was linked in this environment, so no real outgoing or
  incoming peer call, relay negotiation, MLow/SRTP media, browser microphone
  uplink, or speaker downlink was exercised against WhatsApp. Do not describe
  this branch as 100% live-call validated until those checks pass with a test
  account on the deployment network.

## Important merge / operations notes

- Full voice calls are supported only when `ENGINE_TYPE=zapo`. Existing
  `whatsapp-web.js` and Baileys sessions remain signaling/media incapable and
  return HTTP 501 for call controls.
- Zapo cannot import existing Baileys or whatsapp-web.js credentials. Switching an
  installation to Zapo requires linking it as a new companion device.
- The media path requires `@roamhq/wrtc`, `libmlow-wasm`, and outbound UDP access
  to WhatsApp relays. Browser microphone capture requires localhost or HTTPS.
- `ws` is a direct runtime dependency because Zapo loads it as an optional Node
  peer. `recoverFromClientTooOld` is enabled so stale WA Web version failures can
  self-recover.
- Zapo account passkey signing is not implemented; passkey-required pairing fails
  explicitly. Per-session HTTP(S) and SOCKS proxies apply to linked-device
  WebSocket signaling only; voice relay media remains direct and requires
  outbound UDP.
- The initial Zapo adapter intentionally supports session lifecycle, plain text,
  chat list/history, number lookup, read/unread/delete-chat, typing state, and
  voice calls. Other messaging features return explicit
  `EngineNotSupportedError` responses until mapped and added to the capability
  matrix.
- Unit/integration coverage uses mocked call media. Final WhatsApp-to-browser audio
  still requires a real linked phone/account for live validation; no credentials
  are stored in this branch.
