# The agent's image: `mastra build`, then `node`. `make image VERSION=x.y.z` builds it for linux/amd64
# and linux/arm64; compose.agent.yaml runs it beside an hdtp-gateway node.
#
# Pinned by digest, the tag kept for the reader: `node:22.23.3-alpine` as resolved on 2026-10-20 (the
# multi-platform index; its images were built 2026-09-23).
ARG NODE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
ENV MASTRA_TELEMETRY_DISABLED=1
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
# Writes .mastra/output: the server bundle and the node_modules it installs for it, built on the
# image's own platform. No Studio: without --studio the bundle serves Mastra's /api and the webhook.
RUN npx mastra build

FROM ${NODE_IMAGE}
ARG VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/humandelegatedtrustprotocol/hdtp-gateway-agent" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="An open-source Mastra agent that answers an HDTP node's contacts on behalf of its owner"
# MASTRA_HOST: every interface of the container, so the node's container can post to it; the
# container's port is published nowhere unless its owner publishes it. The data directory is a
# volume's mount point; the persona is the example one until another file is mounted over it.
ENV NODE_ENV=production \
    MASTRA_TELEMETRY_DISABLED=1 \
    MASTRA_HOST=0.0.0.0 \
    PORT=4111 \
    HDTP_AGENT_DATA_DIR=/data \
    HDTP_PERSONA_FILE=/app/persona.md
WORKDIR /app
COPY --from=build /src/.mastra/output ./
COPY persona.md ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 4111
CMD ["node", "index.mjs"]
