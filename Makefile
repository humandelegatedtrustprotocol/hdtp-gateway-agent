# The gate: `make check` runs from githooks/ before every commit and every push. There is no CI.

export MASTRA_TELEMETRY_DISABLED := 1

.PHONY: check typecheck test build dev

check: typecheck test build

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
