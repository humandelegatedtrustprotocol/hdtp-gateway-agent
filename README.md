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

## What it answers, and what it leaves to the owner

Each rule is decided before the agent reads a thread, so whatever it leaves is still unread in the
owner's portal.

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

Work in progress: the full README follows.

```sh
cp .env.example .env   # then fill it in
npm ci
npm run dev            # Mastra Studio at http://localhost:4111 (this machine only)
make check             # typecheck, tests, build
```

Apache-2.0.
