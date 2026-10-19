# hdtp-gateway-agent

An open-source [Mastra](https://mastra.ai) agent that answers an
[hdtp-gateway](https://github.com/humandelegatedtrustprotocol/hdtp-gateway) node's contacts on
behalf of its owner, in the voice `persona.md` sets, and asks the owner when the decision is
theirs. It is woken by the node's webhook and acts through the node's owner MCP; the model chooses
each turn and has no tools.

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

It also needs the owner MCP's asks and notices (`ask_owner`, `notify_owner`, `list_asks`): the
first hdtp-gateway release that carries them (N1, the owner's asks, on hdtp-gateway's
`feat/owner-asks`; no release carries it yet). At start, before it reads any thread, the agent
checks that the node offers every tool it calls. If one is missing it answers nothing, and logs
one line naming the missing tools, for example
`{"level":"warn","code":"tools_missing","tools":"ask_owner,notify_owner,list_asks"}`. A tool the
node lists but the MCP client cannot take is named too, with the reason in `skipped`
(`ask_owner:schema_too_large`, `schema_too_deep` or `schema_invalid`). After the node is upgraded,
restart the agent.

## Each turn: reply, ask, notify or none

For the contact's newest message the model returns one JSON object, one of four turns. Code checks
it against a schema built from the node's own tool schemas (read from its `tools/list`), and refuses
anything else by code (`draft:invalid_turn`); a refused turn is drafted again on a later pass, up to
3 attempts, as a failed draft always was. A null the schema does not take is read as the field left
out, so a null on an optional field passes and one on a required field is still refused. Each
draft is one model call capped at 4096 output tokens, reasoning included; a call that stops at the
cap is refused (`draft:truncated`) and counts as a failed attempt, so a model that pads a turn
cannot hold a thread for minutes. The cap is fixed in code, not a setting.

- **reply**: a message to the contact, sent with `send_to_contact`.
- **ask**: a card for the owner, put with `ask_owner` for the message it is about, from the node's
  component catalog: a one-line TLDR and the key terms first, one to three ready replies, and a box
  to write their own last. Nothing goes to the contact. While any ask of a thread is open the agent
  drafts nothing on that thread, and a newer message from the contact stays unread for the owner.
  A ready reply the owner taps, or words they write, are sent to the contact by the node as the
  owner's message; the agent then carries on from the thread. An ask that ends with its message still
  the newest (answered with no message, or expired) is drafted for once more, with what became of it,
  and only a reply, a notice or none is offered then.
- **notify**: a card for the owner with no buttons, put with `notify_owner`: a TLDR of what was
  agreed. The model is told that something is agreed only once both sides have said yes to the same
  terms, so a reply that still asks the contact to book or confirm goes without a notice, and the
  notice follows their confirmation. It is shown the TLDRs of the notices already put on the thread,
  and told not to notify one agreement twice. In code, a notice is put for the message it answers
  and the node keeps one per message. A reply to the contact may go with it, sent first. A notice
  the node did not take is put again on later passes, with no new draft.
- **none**: nothing is sent, for an acknowledgement or a sign-off, so two agents end a conversation
  when it ends rather than at the turn cap. It counts as answered: the message is not drafted for
  again.

An agent-answered request takes a reply only; its text is the answer.

## Autonomy

The persona says, per topic, which of two stances the agent takes:

- **ask before committing**: it proposes and negotiates within the limits, then asks before
  anything is agreed;
- **commit within limits and notify**: it agrees within the limits, then notifies the owner once
  the other side has confirmed.

`persona.md` has an example `## Autonomy` section, and `examples/personas/` has both sides of seven
use cases (a meeting, an event venue, GPU procurement, a rent renewal, a dentist's appointment, a
leave request, a refund), each with its limits and its stances. The model follows the stances; code
does not read them. What code enforces is the rules below, which hold for every turn.

## What it answers, and what it leaves to the owner

Reading is not handling. The owner can keep a conversation open in the portal, which marks the
contact's messages read, and the agent still takes its turn: it sits between the two sides until
the owner writes in the thread themselves, or answers an ask. Then the thread's newest message is
the owner's, and the agent has nothing to answer until the contact writes again. The agent notices
a new message by the thread moving (its newest message's time), not only by unread counts, on
every pass after the first one since it started; a thread the owner read while the agent was
stopped is left to them.

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
- **At most `HDTP_AGENT_REPLIES_PER_HOUR` drafts per contact per hour** (10 by default). Every
  turn drafted for any of their threads (a reply, an ask, a notice or none, sent or refused) and
  every answer to their requests count alike, whatever the messages' sender labels say. A restart
  starts every count again.
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
