# Changelog

## 0.1.0

The first version. It is not published to npm (`package.json` stays `private`); the image is built
from the tag `v0.1.0` by `make image` (README, "In a container, beside the node"). It needs
hdtp-gateway v0.3.0 or later.

- The agent: a Mastra agent that answers an HDTP node's contacts in the voice `persona.md` sets, woken by
  the node's signed webhook, a `wait_for_updates` long poll per account and a sweep every
  `HDTP_RECONCILE_SECONDS`, acting through the node's owner MCP (#1, #18, #19, #21).
- The model is OpenAI's GPT-6 Luna through OpenRouter by default; `HDTP_AGENT_MODEL` takes another
  Mastra model router string (#14).
- Each turn is a reply, an ask, a notice or none. A node that lacks a tool the agent calls is
  refused at start (#36).
- The owner is told of a turn given up; a retry is told what refused the attempt before it; the span
  of a given-up turn is marked failed (#49).
- A notify whose reply the model put inside the notice is refused as `draft:reply_in_notice`, and its
  retry is told the path, `/notice/reply`, and must still answer the contact (`draft:reply_dropped`
  otherwise); the frame and the turn schema say where a notice's reply goes (#57).
- `send_to_contact`'s answer is read in the node's new shape (#51).
- Answers trusted contacts only unless `HDTP_AGENT_ANSWER=all`, only what arrived after the first
  start, at most `HDTP_AGENT_REPLIES_PER_HOUR` drafts per contact per hour, and
  `HDTP_AGENT_TURN_CAP` agent-to-agent turns in a row per thread; each reply keyed on the node's
  message id (#23).
- Studio refuses a request to any host but its own, and its API refuses writes from any other origin
  (#23, #27); `src/mastra/origins.ts` lists Mastra's eight public auth routes and what each answers
  (#38).
- Studio's Observability pages show every webhook, pass and log line, in memory for 24 hours (#41);
  a webhook the agent refuses keeps no span (#46).
- The agent as an image, `compose.agent.yaml` beside the node, and `MASTRA_HOST` (#46).
- `make eval`: the turn eval, 55 model calls at most.
- `docs/a2-observed.md`: the agent against two real nodes (#16); `docs/advisories.md`: each npm
  advisory read against how the agent uses the package (#23).
- Known, open: #5 (Studio frames text differently from the webhook path), #25 (a thread stopped at the
  turn cap is marked read), #29 (an unwritable data directory leaves the agent idle even with a
  readable `first-start.json`), #39 (an ask answered with no message is not drafted for again after a
  restart until the contact writes).
