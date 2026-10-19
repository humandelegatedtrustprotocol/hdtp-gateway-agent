# A2: the agent against a real node, observed

Run on 2026-10-19 on one Mac. The agent was this repository at `feat/openrouter-default` (8cda5be),
started with `make dev`. The model was the default, `openrouter/openai/gpt-6-luna`, through
OpenRouter. The nodes were built from hdtp-gateway `main` at 2170fda (webhooks, PR #209). Nothing in
this run was a fake: two real nodes, real passkeys, real certificates, a real CalDAV server, and a
real model.

## The setup

- **Two nodes, native binaries, one shared limits sidecar.**
  - The owner node holds identity `ana`. Portal and owner MCP at `127.0.0.1:19080`; public at
    `https://ana.localtest.me:19443`.
  - The contact node holds identity `ben`. Portal at `127.0.0.1:19081`; public at
    `https://ben.localtest.me:19444`.
  - `*.localtest.me` resolves to 127.0.0.1, so each node dialled the other at its public address.
  - Two nodes, not one with two identities: the node's webhooks run found that two identities on
    one node, which share one host name, cannot reach each other.
- **Identities.** Each was created with `hdtp-gateway account create`. Each wallet (`hdtp` 0.7.3)
  signed its node's leaf, which was installed with `account install-leaf`.
- **Portals.** Each passkey was registered in headless Chrome, through a virtual authenticator.
- **Pairing.** `ana` made an invite, `ben` redeemed it, and `ana` approved `ben` with the `friend`
  preset. All three went through the portals' form routes, posted from the signed-in pages.
- **Ana's portal.** These two steps were done by clicking through the pages.
  - The **Owners** page made the owner MCP token: "Agent tokens", label, Create, shown once.
  - The **Webhooks** page added the endpoint `http://127.0.0.1:4111/hdtp/webhook` (every event).
    The page showed the signing secret once.
  - The token, the secret and `HDTP_OWNER_MCP_URL=http://127.0.0.1:19080/owner/mcp` went into the
    agent's git-ignored `.env`. The OpenRouter key is in the same file.
- **Persona.** The agent ran with a persona for Ana written for this run, through
  `HDTP_PERSONA_FILE`. It is not the example `persona.md`, which answers for "Alex".
- **Sweep.** `HDTP_RECONCILE_SECONDS` was the default, 60.

### Clocks

Every time below is the host's clock, in seconds since the epoch, with three decimals. There are
three sources:

- **The logs.** The nodes' and the agent's output was piped through a stamper that adds the moment
  each line was read.
- **The portal.** In Ben's portal, `Date.now()` was taken in the page before and after the Send
  click. A poll every 100 ms of the API the Messages page renders from (`/api/conversations`)
  recorded when the reply first appeared.
- **Ben's owner MCP.** For (b), (c) and (d), Ben's side was driven through his owner MCP, timed in
  the calling script, which polled `read_thread` every 200 ms.

A node's audit line is written when the action finishes. So "read_thread" below is the moment that
call returned.

## (a) A message, a signed webhook, a drafted reply

Ben typed a message in his portal's Inbox and pressed Send. The message is labelled `human`.

| Time | Where | What |
|---|---|---|
| 547.426 → 547.442 | Ben's portal | the Send click |
| 547.451 | owner node | `contact send_message … delivered`: the message is in Ana's inbox |
| 547.455 | agent | `webhook_accepted evt_13 message.received`: the signature was verified (the node's delivery log: HTTP 202, 3 ms) |
| 547.460 – 547.487 | owner node | `list_accounts`, `get_inbox`, `read_thread` over the owner MCP |
| 549.363 | contact node | the reply arrives from Ana's node |
| 549.366 | owner node | `send_to_contact ok`; agent `replied` |
| 549.441 | Ben's portal | the reply is in the conversation, labelled `agent` |

From the click to the reply on Ben's screen: **2.0 s**. Of that, about 1.88 s lies between
`read_thread` returning and `send_to_contact` returning. That span holds the OpenRouter draft and
the delivery to Ben's node. The webhook hop, from the message stored to the agent accepting the
signed post, took 4 ms. A screenshot of Ben's Inbox showed the reply under his message with its
`agent` badge.

## (b) The turn cap, with the contact's side an agent

The node labels every message sent through an owner MCP as `agent`; only the portal's compose box
is `human` (`messaging.Origin.Sender`). So Ben's side was made an agent by sending through Ben's
owner MCP (`send_to_contact`), in the same thread, one message at a time. Each send waited up to
30 s for Ana's side to answer. On Ana's node, `read_thread` showed each of Ben's messages inbound
with `sender: agent`.

| Ben's message | Reply after | Agent log |
|---|---|---|
| 1 (agent) | 1.28 s | `replied` |
| 2 (agent) | 1.28 s | `replied` |
| 3 (agent) | 2.77 s | `replied` |
| 4 (agent) | no reply in 30 s | `agent_turn_cap turns:3`, 10 ms after `webhook_accepted` |

The fourth message drew no model call. Ben then wrote in his portal, a `human` message, and the
count started again: a reply appeared on his screen 2.74 s after the click.

## (c) A missed webhook, answered by the reconcile pass

1. The agent was stopped. Ben wrote in his portal at 672.610.
2. The node's one attempt failed. Ana's Webhooks delivery log showed `evt_29 message.received`
   **failed**, "dial tcp 127.0.0.1:4111: connect: connection refused". The node does not retry
   (ruling C).
3. `make dev` was started again at 709.416. The server was up at 716.564, and its first sweep ran
   at once: `list_accounts` at 716.616, `get_inbox` at 716.638, then `read_thread` at 716.649.
4. `send_to_contact` returned at 718.963, and the reply was in Ben's thread at 719.004.

From the server up to the reply at Ben's node: **2.4 s**. The Chrome tab was kept off Ana's
conversation throughout, so nothing marked the thread read before the sweep.

## (d) An agent-answered call: request.pending

An agent-answered capability needs a tool in a connected integration's catalog. The node publishes
an agent-mode entry only for a tool its snapshot lists. So the owner node was given one:

1. A Radicale CalDAV server ran locally in a container.
2. A `stdio-supervised` integration, `cal`, was created on Ana's node through the portal's form
   routes. It runs `caldav-mcp` from the node's own `hdtp-gateway:harness-caldav` image.
3. It connected (`integration_connect … ok`, catalog v1).
4. `list-events` was exposed in **agent** mode as `cal_list_events`. A first submission without the
   write acknowledgment was refused with 400; the second carried it.
5. Ana's owner MCP granted Ben `integration.cal` (`set_permissions`).

Ben's owner MCP then called `call_contact` with `tool: cal_list_events`:

| Time | Where | What |
|---|---|---|
| 739.373 | Ben's side | the call starts |
| 739.440 | owner node | `pending_create` |
| 739.443 | agent | `webhook_accepted evt_32 request.pending` |
| 739.451 | owner node | `list_pending` |
| 742.226 | owner node | `answer_request ok`, `pending_relay ok`; agent `answered` |
| 742.245 | Ben's side | the call returns with the agent's text |

The call took **2.87 s**, inside the node's 30 s wait budget. The answer was the agent's own words,
saying that Ana would reply in person. The CalDAV tool was not called. The entry had no fallback,
and in agent mode the node calls the upstream only as a fallback (`AgentAnswered.Handler`, read
from the code).

The call came 23 s after the agent's last owner-MCP request. The node counts the owner's agent as
attached only while its last request is under a minute old (`presence.Window`). This agent sweeps
every `HDTP_RECONCILE_SECONDS` and does not hold a `wait_for_updates` loop. A call more than about a
minute after a sweep would therefore find the agent absent and fall back at once (`no_agent`). That
is read from the code; this run did not show it.

## What it cost

Seven model calls through OpenRouter: one in (a), three in (b) plus one after the reset, one in (c)
and one in (d). The capped fourth message in (b) made none.

## What this run did not cover

- **The compose file.** A2 in the plan joins the node's compose project, with the agent reached at
  `http://agent:4111/hdtp/webhook`. This run used native binaries, which needed no compose file, so
  none was added. It is next, with the image.
- **Deliberate refusals.** No bad signature was sent on purpose. The `webhook_bad_signature` lines in
  the agent's log came from the run script's readiness probe, an unsigned `POST` that the receiver
  refused with 401.
