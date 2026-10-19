# The gate: `make check` runs from githooks/ before every commit and every push. There is no CI.

export MASTRA_TELEMETRY_DISABLED := 1
# Studio calls its API at the address it was opened at: localhost and 127.0.0.1 both work.
export MASTRA_AUTO_DETECT_URL := true

.PHONY: check typecheck test build dev eval image

# build before test: test/cli.test.ts runs `mastra dev`, which opens .mastra/.build/entry-0.mjs, a
# file `mastra build` writes. Without it `mastra dev` logs ENOENT and serves nothing.
check: typecheck build test

typecheck: node_modules
	npx tsc --noEmit

test: node_modules
	npx vitest run

build: node_modules
	npx mastra build

dev: node_modules
	npx mastra dev

node_modules: package-lock.json
	npm ci
	@touch node_modules

# The turn eval (eval/run.ts): real model calls, 50 at most, so not part of check. EVAL passes its
# flags, e.g. EVAL=--dry, or EVAL='--runs 1 --only u1-3'.
eval: node_modules
	@node --env-file-if-exists=.env eval/run.ts $(EVAL)

# The image, for linux/amd64 and linux/arm64, tagged <version> and latest, from a clean tree at the
# tag v<version> only: `make image VERSION=0.1.0` builds it, `make image VERSION=0.1.0 PUSH=1`
# builds and pushes it (after `docker login ghcr.io`). Without PUSH it is kept in Docker's own store,
# which needs the containerd image store for two platforms (Docker Desktop's default).
IMAGE := ghcr.io/humandelegatedtrustprotocol/hdtp-gateway-agent
PLATFORMS := linux/amd64,linux/arm64
image:
	@test -n "$(VERSION)" || { echo "usage: make image VERSION=x.y.z [PUSH=1]" >&2; exit 2; }
	@test "$$(git describe --exact-match --tags HEAD 2>/dev/null)" = "v$(VERSION)" || { echo "image: HEAD is not the tag v$(VERSION)" >&2; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "image: the tree has changes git does not ignore" >&2; exit 1; }
	docker buildx build --platform $(PLATFORMS) --build-arg VERSION=$(VERSION) \
		-t $(IMAGE):$(VERSION) -t $(IMAGE):latest $(if $(PUSH),--push,--load) .
