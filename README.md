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

The model sees the thread's newest 20 messages with who wrote each, from the node's sender label:
the contact, the owner (a message they wrote in the portal, or a ready reply they chose), or the
agent itself. It is told that what the owner wrote is their decision, so a yes they already gave is
not treated as one still to come. Their answers to the thread's earlier asks are shown to it as
their decisions too. The owner is named in the thread by their display name: `display_name` from
the node's `export_card`, the name on the account's card, read once per account at start and kept
until the agent restarts. A card with no name, or a node whose `export_card` gives none, leaves the
owner labelled "person" (`owner_name` in the log says whether a name was read; `owner_name_unread`,
with the refusal, when the card could not be read, and the agent drafts on with "person").

- **reply**: a message to the contact, sent with `send_to_contact`. The model is told that when the
  contact accepts what this side proposed, this side confirms it with a reply rather than none; and
  that when the contact confirms a yes the owner gave themselves, nothing more is sent and no notice
  is put, since the owner knows already.
- **ask**: a card for the owner, put with `ask_owner` for the message it is about, from the node's
  component catalog: a one-line TLDR and the key terms first, then one to three ready replies, each
  a Button the owner taps once to send it, and last a box to write their own with the Button that
  sends it (its event named anything but `reply`, which the node keeps for ready replies). Nothing
  goes to the contact. While any ask of a thread is open the agent
  drafts nothing on that thread, and a newer message from the contact stays unread for the owner.
  A ready reply the owner taps, or words they write, are sent to the contact by the node as the
  owner's message; the agent then carries on from the thread. An ask that ends with its message still
  the newest (answered with no message, or expired) is drafted for once more, with what became of it,
  and only a reply, a notice or none is offered then. Across a restart of the agent the hold survives,
  since the node keeps the ask and every visit checks it; the once-more draft does not, since the
  agent keeps the threads it is waiting on in memory: an ask that ends after a restart, or just before
  one, is not drafted for again, and the thread's next message from the contact is answered as usual. The model is told to ask only where the
  persona makes the decision the owner's for the topic, and to reply while it can answer within the
  owner's limits, offering times or terms included, so the ask comes when the contact's definite terms
  wait for the owner's yes; and that each ready reply is the owner's own message, first person and complete,
  never an instruction to the agent, the owner in the third person or a bare label. Code checks one
  thing of their wording: an ask whose ready reply names the owner, by their first name or their whole
  name as whole words, is refused (`draft:reply_names_owner`) and drafted again, since a reply that
  names the person sending it speaks of them in the third person. The ready replies are found by
  their shape in the node's components (a Button's event named `reply`, a ChoicePicker's options),
  not by a component's place. With no display name there is nothing to check.
- **notify**: a card for the owner with no buttons, put with `notify_owner`: a TLDR of what was
  agreed. The model is told that something is agreed only once both sides have said yes to the same
  terms, so a reply that still asks the contact to book or confirm goes without a notice, and the
  notice follows their confirmation; choosing one of several options the contact offered is not yet
  an agreement; and terms the owner said yes to themselves are never notified. It is shown the TLDRs of the notices already put on the thread,
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

`make eval` measures how well a model follows them. It drafts the turn at ten points of the
meeting and dentist stories (`eval/points.ts`), with the example personas, through the agent's own
path: the frame and persona as instructions, the configured model, the 4096-token cap, and the
turn read against the node's schema as `test/owner-mcp-tools.json` holds it. It runs 5 times per
point, 50 model calls, the most one run makes, never retried. It prints one JSON line per call and,
per point, how many turns were of a passing type and how many were valid. `EVAL=--dry` builds every
prompt and calls no model; `EVAL='--runs 1 --only u1-3'` runs part of it. It is not part of
`make check`, which holds its points and its dry run with no network.

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
