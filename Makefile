# The gate: `make check` runs from githooks/ before every commit and every push. There is no CI.

export MASTRA_TELEMETRY_DISABLED := 1
# Studio calls its API at the address it was opened at: localhost and 127.0.0.1 both work.
export MASTRA_AUTO_DETECT_URL := true

.PHONY: check typecheck test build dev

# build before test: test/cli.test.ts runs `mastra dev`, which needs the build's output.
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
