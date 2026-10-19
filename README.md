# hdtp-gateway-agent

An open-source [Mastra](https://mastra.ai) agent that answers an
[hdtp-gateway](https://github.com/humandelegatedtrustprotocol/hdtp-gateway) node's contacts on
behalf of its owner, in the voice `persona.md` sets. It is woken by the node's webhook and acts
through the node's owner MCP; the model drafts the text and has no tools.

The model is OpenAI's GPT-6 Luna through
[OpenRouter](https://mastra.ai/models/gateways/openrouter) by default
(`openrouter/openai/gpt-6-luna`, with `OPENROUTER_API_KEY`). `HDTP_AGENT_MODEL` takes any other
Mastra model router string instead, with that provider's key.

Three things wake it. The node's signed webhook names a message or a request. A `wait_for_updates`
long poll per account wakes it as soon as a thread moves or a request waits. A sweep every
`HDTP_RECONCILE_SECONDS` (60 by default) answers what both missed. The node counts the owner's
agent as attached only while its last owner-MCP request is under a minute old. A contact's call to
an agent-answered capability finds no agent outside that minute, and the node falls back at once.
The node holds each wait for at most 25 s, so the loop keeps the agent attached between sweeps.
`docs/a2-observed.md` records runs against two real nodes.

It needs a node whose owner MCP `read_thread` gives each message its `message_id`
([hdtp-gateway#208](https://github.com/humandelegatedtrustprotocol/hdtp-gateway/issues/208)): the
first hdtp-gateway release after v0.2.0, which carries #208 (v0.3.0 is planned). v0.2.0 and earlier
give none, and the agent answers no thread of theirs (`message_id_missing` in its log). Each reply
is sent under a `msg_id` derived from the id of the message it answers, so every path that reaches
one message, in any process, sends one reply, which the node records once.

## What it answers, and what it leaves to the owner

The first three rules are decided before the agent reads a thread, so whatever they leave is still
unread in the owner's portal.

- **Only contacts the owner trusts, by default.** A contact is trusted when the owner has set
  its trust to "May instruct your agent" (`may_instruct`) on the contact's page in the portal.
  Every other contact's messages and requests are left to the owner. `HDTP_AGENT_ANSWER=all`
  answers every active contact instead, as a public demo node would.
- **Only what arrived after its first start.** The first start writes its time to
  `first-start.json` in the data directory: `HDTP_AGENT_DATA_DIR`, by default `data/` in the
  directory the agent was started from. Every later start reads it back, so a restart does not move
  it. A thread whose newest message is older is the owner's backlog. Delete the file to make the
  next start count as the first. A file that is there and cannot be read stops the agent answering
  anything (`first_start_unreadable` in its log) until it is fixed or deleted.
- **At most `HDTP_AGENT_REPLIES_PER_HOUR` drafts per contact per hour** (10 by default). Replies to
  any of their threads and answers to their requests count alike, whatever the messages' sender
  labels say. A restart starts every count again.
- **`HDTP_AGENT_TURN_CAP` agent-to-agent turns in a row per thread** (3 by default), so two agents
  cannot answer each other forever.

## What Studio shows

`npm run dev` serves Mastra Studio at http://localhost:4111, to this machine only. Its
Observability pages show what the agent did:

- **Traces**: one for each webhook hit (`webhook`, a bad signature included), each reconcile pass
  (`reconcile`, every `HDTP_RECONCILE_SECONDS`, so a quiet agent adds one a minute by default) and
  each pass a wait loop starts (`watch_pass`). A line logged outside those, such as the start's
  `first_start` or a wait loop's `watch_failed`, is a trace of its own, named by its code. A draft's
  agent run and its model call sit under the trace of the pass that drafted it: a new message wakes
  both the webhook and the wait loop, and the first to reach the thread drafts. That trace holds the
  whole prompt and the draft: the persona, and the thread's messages as the contact wrote them. One
  for a one-line message held about 19 KB.
- **Logs**: the agent's log lines from `info` up, with the same codes and fields it prints
  (`webhook_accepted`, `replied`, `agent_turn_cap`, and so on), each in its trace. A hit that draws
  no model call, such as a bad signature, a turn cap, the hourly limit or a contact the agent does
  not answer, shows here too. Mastra's own lines are printed and not kept.

Both are held in the agent's memory only. Nothing is written to disk, and a restart empties both.
Every minute a sweep deletes the traces that started more than 24 hours ago, and with each one its
log lines.

Work in progress: the full README follows.

```sh
cp .env.example .env   # then fill it in
npm ci
npm run dev            # Mastra Studio at http://localhost:4111 (this machine only)
make check             # typecheck, tests, build
```

Apache-2.0.
