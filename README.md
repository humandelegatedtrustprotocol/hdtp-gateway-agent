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

Work in progress: the full README follows.

```sh
cp .env.example .env   # then fill it in
npm ci
npm run dev            # Mastra Studio at http://localhost:4111 (this machine only)
make check             # typecheck, tests, build
```

Apache-2.0.
