#!/bin/sh
# Pre-review verification: typecheck, build, tests, dependency audit, and git-ignore checks.
# Fails on the first problem (set -e). Read-only apart from rebuilding dist/.
set -eu
cd "$(dirname "$0")/.."

npm run typecheck
rm -rf dist && npm run build
npm test
# Optional local dev-tooling check; not part of the product and skipped when the tooling is absent.
if [ -f .claude/helpers/hook-handler.cjs ] && [ -f tests/pre-bash-hook.test.cjs ]; then node --test tests/pre-bash-hook.test.cjs; fi
npm audit

# `git check-ignore -q` accepts exactly ONE path (several paths → "fatal", exit 128),
# and directory patterns like `data/` only match paths under them, so check real file paths.
PRIVATE=".env data/leads.db data/leads.db-wal dist/main.js node_modules/zod .swarm/memory.db ruvector.db \
  .claude/settings.json .claude/settings.local.json .claude-flow/config.yaml .mcp.json CLAUDE.md \
  docs/upwork-portfolio.md tests/pre-bash-hook.test.cjs"
for path in $PRIVATE; do
  if ! git check-ignore -q "$path"; then
    echo "verify: NOT git-ignored: $path" >&2
    exit 1
  fi
done

# Private files must never be tracked, even if ignored later.
for path in .env .mcp.json CLAUDE.md docs/upwork-portfolio.md; do
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "verify: private file is tracked by git: $path" >&2
    exit 1
  fi
done
if [ -n "$(git ls-files .claude .claude-flow)" ]; then
  echo "verify: internal tooling is tracked by git" >&2
  exit 1
fi

echo "verify: all checks passed"
