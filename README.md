# hdtp-gateway-agent

An open-source [Mastra](https://mastra.ai) agent that answers an
[hdtp-gateway](https://github.com/humandelegatedtrustprotocol/hdtp-gateway) node's contacts on
behalf of its owner, in the voice `persona.md` sets. It is woken by the node's webhook and acts
through the node's owner MCP; the model drafts the text and has no tools.

Work in progress: the full README follows once it has been run against a real node.

```sh
cp .env.example .env   # then fill it in
npm ci
npm run dev            # Mastra Studio at http://127.0.0.1:4111 (this machine only)
make check             # typecheck, tests, build
```

Apache-2.0.
