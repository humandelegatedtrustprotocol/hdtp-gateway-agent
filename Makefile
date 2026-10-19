# The gate: `make check` runs from githooks/ before every commit and every push. There is no CI.

export MASTRA_TELEMETRY_DISABLED := 1
# Studio calls its API at the address it was opened at: localhost and 127.0.0.1 both work.
export MASTRA_AUTO_DETECT_URL := true

.PHONY: check typecheck test build dev eval

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
