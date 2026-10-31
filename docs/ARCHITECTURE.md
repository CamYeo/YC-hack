# APPRENTICE architecture

A voice-first Socratic seminar practice room you can join alone. Three audible AI participants
(internal IDs facilitator, maya, theo) and a background Evidence agent discuss a topic with one
human learner. Classroom is the default theme. The optional Halloween theme presents the speakers
as Jack Skellington, Count Dracula, and Wednesday Addams. New UI-created rooms are Socratic;
legacy format types remain supported for previously stored rooms.

```text
Browser (React/Vite :5173)
  ├─ Backend WebSocket /ws ── forwarded public Terse snapshots, speak/stop commands,
  │                          playback acks, human turns, controls
  └─ Audio: ElevenLabs MP3 segments via /api/tts (or labelled browser speech fixture); STT via ElevenLabs Scribe
Backend (Bun :3001, loopback only)
  ├─ config/       explicit hackathon-only config (.env.hackathon.local + .local/relay-workspace.json)
  ├─ providers/    relay (live Relaycast + memory fake), elevenlabs (fetch)
  ├─ agents/       OpenAI Responses reasoning; participant roles and private working notes
  ├─ seminar/      orchestrator: bridge (Relay → actor), floor controller, epochs/cancellation, reflection
  ├─ tools/        deterministic payment-retry simulator, source lookup, topic-bound tools
  └─ terse/        explicit HTTP actor invocation + reconnecting backend-only snapshot subscription
Terse local runtime (:7100) — SeminarActor per room: config, phase, version, epoch, transcript,
  board, floor lease, pending proposals, evidence, turn state, trace, dedupe keys, outbox.
Relaycast (hosted) — channel `sem-<roomId>`; identities facilitator, maya, theo, evidence, bridge, learner.
```

The browser has one room WebSocket, owned by the backend. The backend subscribes to actor-pushed
`{ type: "snapshot", state }` events through `RoomStore.subscribe`, and also reads state after
transitions and Relay deliveries. Both paths forward public state with dedupe/outbox internals
omitted. The actor keeps its persisted field private and explicitly broadcasts `publicSnapshot`;
it does not mark the full room `@Emittable`. Backend socket grants use explicit loopback HTTP
configuration and remain inside the adapter. Direct browser Terse grants are not exposed. The
observer reconnects with bounded backoff; the backend watchdog remains a fallback.

## Non-negotiables this design enforces

- **Relay is the transport between agents.** Workers only learn about the discussion through Relay
  deliveries (channel posts + DMs). Proposals reach the floor controller as `floor.requested` DMs to
  the `bridge` identity. Evidence requests are DMs to `evidence`; results are channel posts.
  If Relay fails, the session pauses visibly; there is no direct-call bypass.
- **Terse owns room state and floor control.** Every state transition is a short actor call. The
  backend keeps only transient work (model calls, audio buffers, timers) in memory.
- **Only heard text is shared knowledge.** AI text is split into sentence segments; the browser acks
  each finished segment; `heardText` is the acknowledged prefix. Proposals reference heard text only.
- **Credentials are hackathon-only and explicit** (see `server/config/types.ts`). Child processes
  are spawned with a scrubbed environment. No SDK reads provider env vars (OpenAI and ElevenLabs are
  called with `fetch` and explicit headers).
- **Fixtures are labelled.** Each provider reports `live | fixture | unavailable` and the UI shows it.

## Identities (Relaycast)

| Identity | Type | Role |
|---|---|---|
| facilitator, maya, theo | agent | speaking workers: receive channel posts, DM proposals to bridge, publish their own heard contributions |
| evidence | agent | background worker: receives `evidence.requested` DMs, runs tools, posts `evidence.returned` |
| bridge | system | infrastructure (NOT an AI agent): receives proposals/evidence, writes to the actor, posts floor/session events |
| learner | human | posts the human's completed turns (`human.contributed`) |

Tokens are minted once and stored in `.local/relay-identities.json` (0600), keyed by workspace id.

## Envelope kinds (shared/contracts.ts `RelayEnvelopeSchema`)

| kind | from → to | when |
|---|---|---|
| `session.started` | bridge → channel | room created; carries opening hint |
| `floor.opened` | bridge → channel | kickoff, await timeout, "keep going", evidence back, resume |
| `contribution.heard` | speaker → channel | utterance finished (complete or interrupted prefix) |
| `human.contributed` | learner → channel | completed human turn / correction |
| `floor.requested` | worker → bridge (DM) | proposal or yield for version V / epoch E |
| `floor.revoked` | bridge → channel | interruption/pause: epoch advanced, abort older work |
| `evidence.requested` | worker or learner → evidence (DM) | after a `request_evidence` utterance is granted, or the human presses Run |
| `evidence.returned` | evidence → channel | tool result or failure |
| `session.paused/resumed/ended` | bridge → channel | lifecycle |

Every post goes through the actor outbox: `enqueueOutbound` → POST with `Idempotency-Key: eventId`
→ `markOutboundSent`. On restart, pending outbound events are re-sent (same key → same message id).
Every consumer checks the persisted consumer/event key before acting, then marks the event
processed and acknowledges successful handling. Individual state transitions and outbound posts
also dedupe their event IDs. Failed handling is retryable.

## Core flows

### AI → AI turn (the required causal path)
1. Browser acks the last segment → `playback.finished(completed)` → orchestrator → `finishUtterance`
   (actor: status heard, board update applied, version+1, turn hint computed).
2. The speaker's worker (e.g. Maya's Relay identity) posts `contribution.heard` with the hint.
3. Theo's separate worker receives a push wakeup (or the explicit polling fallback), fetches canonical metadata, validates the envelope, dedupes,
   acks. Hint says Theo is preferred (or Theo is addressed) → build `AgentContext` from the actor
   snapshot (heard text only) → reasoner → `floor.requested` DM to bridge with `basedOnRoomVersion`.
4. Bridge receives it → `submitProposal` (actor rejects stale version/epoch/session/duplicates) →
   backend waits for the collection window → selects → `claimFloor` (serialized actor lease).
5. Orchestrator sends `speak` to the browser; browser plays segment 0…n, acking each.

### Human turn
Mic (ElevenLabs Scribe, VAD commits accumulate) or text → `human.contribution` → actor
`appendHumanContribution` (dedupe eventId, peerStreak=0, version+1, hint) → learner posts
`human.contributed` → workers respond per hint.

### Interruption ("Jump in" or voice onset)
Browser stops and clears audio immediately (measures interrupt-to-silence), sends `human.jumpIn` →
actor `interrupt` (lease revoked, contribution marked interrupted with heard prefix, epoch+1,
pending proposals cleared, awaitingHuman) → bridge posts `floor.revoked`; speaker posts
`contribution.heard` with `interrupted: true` and only the heard prefix → workers abort older-epoch
model calls (AbortController per epoch) and late results are discarded by epoch checks. TTS route
refuses old epochs (HTTP 410), browser ignores `speak` for old epochs.

### Evidence
A worker's proposal with `action: request_evidence` has a short spoken line plus `evidenceRequest`.
Only after that proposal's utterance is fully heard does the orchestrator record the request in
the actor and have the requesting worker DM `evidence`. The evidence worker runs the deterministic tool, posts
`evidence.returned`; bridge records it (`recordEvidenceResult` → board card with status
`tested-under-conditions` / `source-supported`, or the request stays unresolved on failure); if the
floor is idle and not owned by the human, the bridge posts `floor.opened(evidence-returned)` so
peers respond to the actual result. Evidence never takes the floor away from a waiting human.
The human can also run a case from the evidence panel (learner → evidence DM).

### Pause / hidden tab / disconnect / end
Pause, tab hidden for >10 s, or backend WS disconnect → `pauseSession` (lease revoked, epoch+1) →
`session.paused`. Nothing generates while paused. Resume is explicit (user gesture → audio unlock).
End → `beginReflection` → reflection generated (OpenAI or fixture) citing real contribution ids
(validated: ids exist, human-attributed items cite human contributions) → `setReflection` → ended.

### Restart / refresh
Backend start: for each room in `.local/rooms.json`, `recoverAfterRestart` (expired lease → interrupted
prefix, epoch+1, phase paused), resend outbox. Browser refresh: reconnects to the backend socket,
receives the forwarded Terse snapshot, re-renders history, never replays audio; shows Resume.

### Actor deadlines and recovery limits
Every actor mutation commits its single persisted room field and the next alarm in a SQLite
transaction. `nextAlarmAt` selects the earlier of the speaker lease and session deadline during
discussion, and clears the alarm for paused/reflection/ended rooms. `onAlarm` applies the pure,
idempotent `expireDueTimers` reducer. A renewed lease makes an older alarm harmless and schedules
the new deadline. Speaker expiry enters `paused` with `speaker-timeout`; session expiry enters
`reflection` with `session-timeout`. Both revoke the floor, advance the epoch, retain only completed
segments, and emit a `terse / alarm.fired` trace. The coordinator observes pushed phase/epoch changes,
stops stale browser audio, cancels work, and starts reflection when needed.

Verified under the installed 0.14.9 local dev runtime: alarms fire without HTTP snapshot polling;
public state is pushed; renewal defeats the old deadline; subscriptions reconnect after restart;
explicit recovery preserves heard prefixes, dedupe keys, and pending outbox entries. An overdue
probe alarm did **not** automatically wake after a cold runtime restart. Accordingly, autonomous
cold-start alarm wakeup is not claimed; `recoverAfterRestart` and the server watchdog are retained.
Run `bun scripts/rehearseTerseRecovery.ts` for the isolated, non-provider rehearsal. It allocates
temporary state and free ports and never stops the running application or edits user rooms.

`bun --no-env-file scripts/rehearseBackendRecovery.ts` tests a separate failure boundary: it
SIGKILLs only its owned fixture backend after the first acknowledged segment, keeps its isolated
Terse runtime alive, then restarts the backend with the same private room registry. It verifies
the saved prefix, revoked floor, advanced epoch, rejected stale callbacks, and a fresh reply only
after explicit resume. Fixture Relay channels are rehydrated during backend startup. This is
real local actor durability with fixture reasoning/Relay and logical playback, not a provider or
audible playback verification.

### Theme change
`RoomConfig.theme` is optional for backward compatibility; missing means `classroom`. New rooms
persist the normalized theme. `setTheme(roomId, theme)` returns `InterruptResult`: the same effective
theme is a no-op; a real change updates config and version. During discussion it revokes the lease,
clears pending proposals, preserves the heard prefix, and advances the epoch. It preserves
`awaitingHuman`, so changing the cast cannot take a human-owned floor. For paused, reflection, or
ended rooms, phase and epoch stay unchanged; paused time remains excluded from the session budget.
The backend handles cancellation and subsequent Relay floor events. The actor never replays audio
or resumes a paused/ended session because of a theme change.

## Turn policy (pure, in actor/src/roomLogic.ts `computeTurnHint`)

- `wrap-up` when `aiTurnsUsed >= maxAiTurns - 1` or within 45 s of `endsAt`: facilitator summarises.
- **Participate** (default): kickoff → `open` [facilitator] (frames the opening question, hands to a
  peer) → `peer-exchange` → after `aiTurnsBeforeInvite` (default 2) peer turns since the last human
  turn → `invite-human` [facilitator] with `requiredAddressee: "human"` → after
  that invite is heard → `await-human` (awaitingHuman). There is no automatic human-turn timeout;
  the human contributes or explicitly chooses Keep going.
- **Observe**: same, `aiTurnsBeforeInvite` default 5, await timeout 12 s; always interruptible.
- **Lead**: kickoff framing → `await-human`; after a human turn → `respond-to-human` (one AI turn)
  → `await-human`. No await timeout.
- Human turn → `respond-to-human`: addressed peer, else the speaker the human replied to, else the
  less-used peer (facilitator only to connect threads).
- Fresh undiscussed evidence → `respond-to-evidence` [requester's counterpart, requester].
- **Legacy debate rooms only**: opening (facilitator frames; Maya and Theo each state a position fairly; invite
  human) → cross-examination (4 AI turns; invite) → rebuttal (2; invite) → closing (facilitator
  reflection, no victor declared). `hint.debateStage` carries the stage.
- `closed` whenever phase ≠ discussion.

## Floor controller (server/seminar/service.ts)

Current scoring: +100 first preferred speaker, +60 otherwise, −50 same speaker as last turn,
−5 per prior turn by that speaker. Yields and proposals that violate `requiredAddressee` are
excluded. Once every eligible speaker has replied, selection runs immediately. While another
eligible peer is outstanding, the collection window after the first accepted proposal is 120 ms
for fixture reasoning or 350 ms for OpenAI. Only current-version/current-epoch proposals can claim the floor. A proposal
with token-Jaccard similarity ≥0.7 to one of the last four heard AI turns is excluded. If all
received proposals yield or are excluded, an eligible peer still reasoning is allowed to finish;
otherwise the learner gets the floor. The watchdog pauses expired leases and ends exhausted
sessions. The earlier design's 1800 ms collection window, all-worker quorum, and automatic
facilitator retry are not implemented.

Separate worker processes discover new rooms on idle polling, then follow actor-observed room
phases to use active polling. A new discussion version opens a bounded fast-poll window; this
only wakes the Relay inbox and never starts reasoning from an actor snapshot alone. Workers do
not depend on the coordinator's browser `hello` to leave paused cadence. After a floor grant,
the coordinator starts cancellable audio preparation without waiting before sending `speak`.

The optional `HACKATHON_CACHE_OPENING=true` wrapper reuses only the first three untouched
`swe-retries` turns: facilitator with no transcript; Maya with a fully heard facilitator turn;
Theo with fully heard facilitator and Maya turns. Each was generated by OpenAI in an earlier
matching run. Epoch 1 and version = transcript length + 1 exclude edited/resumed/interrupted
paths. Human input, evidence, private notes, reading, custom questions and later turns bypass.
The hash includes the exact semantic transcript/board/relations, all stable context, model,
effort, persona and `SPEAKING_PROMPT_CACHE_VERSION`. Transport IDs are canonicalized; cached
reply and board targets are rebound to the current room and validated. Service context projects
only the declared semantic board fields, excluding persisted timestamps. Entries expire after
seven days, use atomic owner-readable writes, and are bounded to 12 files. Each reuse emits
`opening.cache-hit`; later replies and reflections remain live. Increment the prompt version
when changing speaking instructions or validation semantics.

## HTTP / WS surface (backend :3001, proxied by Vite)

| Route | Notes |
|---|---|
| `GET /api/status` | ProviderStatus (no secrets) |
| `GET /api/topics` | TopicsResponse |
| `POST /api/rooms` | CreateRoomRequest → CreateRoomResponse (roomToken) |
| `POST /api/rooms/:roomId/stt-token` | ElevenLabs single-use `realtime_scribe` token (header `x-room-token`) |
| `GET /api/tts/:roomId/:utteranceId/:segment?epoch=&roomToken=` | MP3 stream; 410 if the lease/epoch is stale |
| `GET /ws?roomId=&roomToken=` | ClientMessage / ServerMessage |

Bound to 127.0.0.1. Requests carrying an `Origin` must match `http://localhost:5173` or
`http://127.0.0.1:5173`. Room tokens are random 32-byte values; only their SHA-256 is stored
(`.local/rooms.json`, 0600). Authorization headers and token query strings are redacted from logs.

## Ports & processes

UI 5173 · backend 3001 · Terse 7100. `bun run dev` (scripts/dev.ts) attempts to bootstrap a Relay
workspace if none is configured, starts the local Terse runtime and waits for its contract endpoint,
then starts the coordinator backend, four independent agent workers when Relay is live, and
Vite — all with a scrubbed environment. Backend and worker exits are supervised and restarted;
Terse retains the room and reconnection requires explicit resume. A reserved external seat
replaces one worker through the local JSONL adapter. Bootstrap failure is fatal in
live mode and labelled in fixture mode. Client generation is not part of startup or the active
HTTP adapter; `actor:generate` is an optional development command.
Bun 1.4.4 is pinned in devDependencies (Terse requires ≥ 1.4.2); `bun run …` puts it first on PATH.

## Conventions

TypeScript strict, no `any` (use `unknown` and narrow), `const` over `let`, early returns,
async/await, zod validation at every boundary (Relay metadata, model output, WS, REST). No `console.*`
in server/web code — use `server/log.ts` (server) or a tiny `web/src/lib/log.ts` (web). Never print
secrets or the process environment. Fixture behaviour is always labelled in the UI.

## Separate worker ownership and actor observation

`SeminarService` roles separate coordinator consumption (`bridge`) from each speaking/evidence
identity. The default all-in-one role remains for memory-transport tests and fixture demos.
The live dev launcher uses `--distributed`: no direct worker method call can produce a speaking
proposal in the coordinator. Worker processes discover new authorized rooms through the local
registry, read authoritative actor snapshots, and send proposals through Relay.

Actor snapshots and Relay deliveries can arrive in different orders. The observer ignores
older epochs/versions and trace revisions, cancels only stale or phase-incompatible work, and
preserves work already running for the incoming epoch. Collection deadlines belong to a
version/epoch round. Reflection cleanup checks the controller identity so a replaced request
cannot remove the newer request. Regression tests exercise these asynchronous orderings.

The configured hosted Relay deployment returned `501 websocket_unavailable`. `deliveryStatus()`
reports polling/unavailable plus the reason. The node-stream implementation preserves manual
acknowledgement after durable processing and uses canonical REST metadata; fake-protocol tests
cover reconnect, crash replay between REST/node acknowledgements, and unsupported-host fallback.
Successful hosted WebSocket delivery and remote guest enrollment have not been demonstrated.
