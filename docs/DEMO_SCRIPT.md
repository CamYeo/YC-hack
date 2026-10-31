# APPRENTICE: demo script (3 minutes + Q&A)

**One line:** Apprentice lets you practise speaking up in a Socratic seminar when you don't have a
seminar to join. Three AI participants debate each other out loud, and you can interrupt and
change where the discussion goes.

Lines in *italics* are what you say aloud. **Do** lines are what you click. **If** lines are the
fallback when something goes wrong.

---

## Ready-to-film cue card

Local app: http://127.0.0.1:5173. Leave the running development services open.

1. Start recording on the Halloween homepage. Capture both computer audio and your microphone; make a short playback check first. Headphones prevent the character voices feeding into your mic.
2. Keep **Software engineering → Intermediate → Join the discussion**. Start a fresh seminar for every take. Do not resume an old room for the cached introduction.
3. Let Jack, Dracula, and Wednesday finish the three-turn opening. Jack asks about retries; Dracula proposes idempotency plus backoff; Wednesday challenges a failure between charging and saving the key.
4. Click **Jump in**, allow microphone access if prompted, and say: **“So the key alone isn't enough. How do we make sure saving the key and charging the customer can't disagree?”** Pause for about 1.5 seconds; your contribution sends automatically. **Done speaking** is an optional shortcut. Their answer to you is live.
5. Show the payment experiment, then the **Agents** tab and the transcript. End with **End & reflect**.

**Before the real take:** verify microphone permission and recording audio in a throwaway seminar, return Home, then start a fresh room. Actual microphone capture has not yet been verified on this browser. If permission fails, use the typed contribution instead.

**Cache disclosure:** the first three turns reuse earlier generated text and audio; responses to your contribution are live. Last measured cached speaker handoffs were 1.5–2.9 seconds. Network timing can vary.

## 15 minutes before

- [ ] `curl -s http://127.0.0.1:3001/api/status`: every provider shows `"mode":"live"` and
      `lastError` is `null`. If Relay shows an error, the workspace may have expired: stop the app,
      run `bun run relay:bootstrap`, then `bun run dev`.
- [ ] Fresh take: return to the homepage and start a new seminar. No service restart or local-state reset is needed.
- [ ] Browser: one tab at http://127.0.0.1:5173, zoom 110–125% so the back row can read it, system
      volume up, notifications off (Do Not Disturb).
- [ ] Microphone: set this exact site's microphone permission to **Allow** in the browser.
      **Jump in** starts recording immediately; after about 1.5 seconds of silence, the final transcript sends automatically and capture closes. **Done speaking** sends sooner. **Cancel microphone** returns to typing. The app never records on page load.
- [ ] Second terminal open in the repo, for the optional recovery proof (see the end of this script).
- [ ] Do one full run-through, end to end. With `HACKATHON_CACHE_OPENING=true`, the first three SWE
      turns are cached after their first generation. Use the same theme, difficulty and participation
      for the demo. Keep `.local/opening-cache` and `.local/speech-cache`; do not reset them after warming.

---

## 0:00–1:00 · The problem

**Do:** Start on the homepage, Halloween theme.

*"Two years ago I was a high school teacher, before I became an engineer."*

*"With AI, getting information is easy. You ask, and the answer is spoon-fed to you in seconds.
But discussion is still hard: defending an idea, having someone push back, changing your mind.
And chatting one-on-one with a bot is mundane and tiring."*

*"Teachers have a tool for exactly this: the Socratic seminar. There's no lecture and no answer
handed out. You get an open question, and students build on each other's ideas, challenge each
other's assumptions and back their claims with evidence. The teacher only facilitates."*

*"The catch is you need a room full of people. So I built the room."*

**Do:** Choose **Software engineering** → **The payment that vanished**, intermediate,
**Join the discussion**. Don't click Start yet: the cached opening begins almost immediately,
so finish talking first.

*"A facilitator and two AI peers argue with each other out loud, and my job is to jump in. Every
light up there is a live service: OpenAI for reasoning, ElevenLabs for the voices, Agent Relay
for the agents talking to each other, and Terse holding the room's state."*
(Point at the provider indicators.)

*"Each AI participant is its own process with its own Agent Relay identity, and they only
coordinate by sending messages. Terse is the referee: it holds the room, grants one speaking turn
at a time, cancels stale speech, and runs the clock even if our server dies."*

**Do:** Click **Start a seminar**.

---

## 1:00–1:15 · Let them argue

**Do:** Nothing. Let the exchange run. Jack frames the timeout, Dracula proposes retrying, and
Wednesday challenges what happens if charging succeeds but saving the idempotency key fails.
Don't talk over them.

**If opening reuse is enabled and warmed:** *"These first three turns are cached from an earlier
generation. Once I jump in, their responses to me are generated live."*

**If** there's a long pause (more than 3 seconds): *"The room is coordinating the next speaking turn through Relay."*

---

## 1:05–1:40 · Change the conversation

**Do:** After Wednesday's opening question, click **Jump in**. If another character has begun, their speech stops. Choose **To Wednesday**, say the line, then pause to send automatically. For typed input, cancel the microphone, type, and send:

> **"So the key alone isn't enough. How do we make sure saving the key and charging the customer can't disagree?"**

**If you interrupted audible speech:** *"I just interrupted the discussion. Terse records which sentences actually finished playing.
Anything I didn't hear is dropped from the transcript, so nobody can reply to words I never
heard."*

**Do:** When the next character replies, open the **Transcript** tab and point at the reply's
link back to your contribution.

*"That reply is responding to my point, not to a generic prompt. You can see it's linked to the
specific thing I said."*

**If** voice transcription mangles it: say "let me type that" and type it. Don't retry by voice.

---

## 1:40–2:20 · Test the assumption

**Do:** Open the **Payment retry laboratory** and click **Run experiment** for each case:
**No key** → **Reuse the same key** → **New key each attempt**.

*"Instead of taking anyone's word for it, we test it. No key: two charges. Same key: one charge.
New key every attempt: two charges again. So the key only protects you if the retry reuses it."*

*"To be fair, this is a simulated server that implements deduplication. A header on its own
doesn't make an arbitrary payment system safe."*

**Do:** Point at **Notes** as the result lands on the shared board.

*"The evidence goes on the shared board, so every agent has to deal with it now, me included."*

---

## 2:20–2:50 · Under the hood

**Do:** Open **Behind the discussion**, then the **Agents** tab.

*"These are real message IDs from Agent Relay. Every proposal, every evidence request, every
handoff between agents went over Relay, from each agent's own identity."*

*"And this is Terse. One durable actor owns the room. It grants exactly one speaking turn at
a time, and when I interrupted, it bumped an epoch counter, so any speech the old turn was still
generating is rejected. If the server crashes, the room comes back paused at the exact sentence
you'd heard. We test that by killing a real backend process and restarting it."*

---

## 2:50–3:00 · Close

**Do:** Click **End & reflect**. Read one line from the reflection that reflects something you
actually said. Don't claim you changed your mind if you didn't.

*"The scary part was never the topic. It was speaking up. Apprentice gives you a room to
practise in."*

---

## Optional 30-second recovery proof (only if you have time and it worked in rehearsal)

In the second terminal:

```sh
./node_modules/.bin/bun --no-env-file scripts/rehearseBackendRecovery.ts
```

*"This kills a real backend process halfway through a sentence and restarts it. The room comes
back paused, with exactly the first sentence marked as heard, and the speech doesn't replay."*

This runs an isolated copy with real Terse and fixture reasoning/voice, so it cannot break your
live room. It uses playback acknowledgements to represent heard sentences. Keep the live
`bun run dev` launcher running; it supervises and restarts backend and worker processes.

---

## Judge Q&A: short, honest answers

**"Why do you need Agent Relay if it's all on one machine?"**
*"Each participant has its own Relay identity, inbox and credentials, and nothing talks directly.
That's what lets a seat be taken by an outside agent. Theo's seat can be handed to an external
agent process through the external-agent adapter (`dev:external` / `worker:external`)."*
(Only claim this if you've run it yourself.)

**"Is delivery real-time?"**
*"It's polling. The hosted Relay returns HTTP 501 for WebSockets, so we fall back to durable polling
and label it in the status. The live status shows measured delivery latency. The adapter supports
WebSockets for when the hosted service enables them."*

**"What does Terse give you over a database?"**
*"Every rule about the room lives in one place. Exactly one speaker, epochs that kill stale
speech, a saved outbox so messages survive a crash, and dedupe so nothing is processed twice.
Plus timers via actor alarms, and state pushed out to subscribers. The restart test proves it
survives a crash."*

**"What's fake?"**
*"The payment experiment is a deterministic simulation. The three-turn introduction can be
reused from an earlier OpenAI generation, and matching ElevenLabs audio is cached. Replies
after the introduction and agent messages are live. We don't replay answers to the human."*

**"How do you know it helps people learn?"**
*"I don't claim it does yet. The homepage links the research on discussion-based learning, along with
its limits. This is a practice tool. Measuring learning would be the next step."*

**"Are those the real characters' voices?"**
*"No. They're selected ElevenLabs library voices: Paul for Dracula, Alaric for Jack, and Nayva
for Wednesday. They fit the characters' delivery; they are not official character performances."*

---

## If something breaks live

| Problem | Say | Do |
|---|---|---|
| No audio | *"Let's go captions-only."* | **Turn sound off**. Captions keep the demo going |
| Microphone fails | *"I'll type my point."* | Type into the contribution box, click **Send contribution** |
| Room pauses with a provider error | *"It pauses rather than faking the conversation, which is deliberate."* | **Resume seminar** |
| Agent stalls for more than 10 s | *"Live models, live network."* | **Resume seminar**, or move on to the experiment |
| Everything is down | *"Here's what it looked like."* | Show `docs/screenshots/orange-live-seminar.png` |
