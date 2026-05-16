#!/bin/bash
set -e

# Preflight audit. Prints a punch list of what's missing before the app
# (in particular the modal flow) can be exercised end-to-end against
# Slack. Exits 1 if any required item is missing, so it composes with
# CI / dev:tunnel.

OK="\033[32m✓\033[0m"
BAD="\033[31m✗\033[0m"
WARN="\033[33m!\033[0m"
fail=0

check() { # name, ok-bool, hint
  if [ "$2" = "ok" ]; then
    printf "  $OK %s\n" "$1"
  else
    printf "  $BAD %s\n     → %s\n" "$1" "$3"
    fail=1
  fi
}
warn() { printf "  $WARN %s\n     → %s\n" "$1" "$2"; }

echo ""
echo "Block Kit Builder Template — setup doctor"
echo ""

# ── wrangler.jsonc KV ids ─────────────────────────────────────────────
echo "wrangler.jsonc"
for binding in SLACK_INSTALLATIONS SLACK_USER_INSTALLATIONS SLACK_OAUTH_STATE SLACK_MODAL_VIEWS; do
  placeholder="REPLACE_WITH_$(echo "$binding" | sed 's/^SLACK_//')_KV_ID"
  if grep -q "$placeholder" wrangler.jsonc 2>/dev/null; then
    check "KV $binding" "no" "run \`pnpm run setup:kv\` and paste the id into wrangler.jsonc"
  else
    check "KV $binding" "ok"
  fi
done

# ── .dev.vars ─────────────────────────────────────────────────────────
echo ""
echo ".dev.vars (local secrets)"
if [ ! -f .dev.vars ]; then
  check ".dev.vars present" "no" "cp .dev.vars.example .dev.vars && fill in values from Slack app Basic Information"
else
  check ".dev.vars present" "ok"
  for secret in SLACK_SIGNING_SECRET SLACK_CLIENT_ID SLACK_CLIENT_SECRET; do
    if grep -E "^${secret}=.+" .dev.vars >/dev/null 2>&1; then
      check "  $secret set" "ok"
    else
      check "  $secret set" "no" "add a non-empty value for $secret to .dev.vars"
    fi
  done
fi

# ── manifest.json ─────────────────────────────────────────────────────
echo ""
echo "manifest.json"
if grep -q "YOUR_WORKER_URL" manifest.json; then
  check "Worker URL substituted" "no" "run \`pnpm run setup:manifest <tunnel-or-worker-url>\` and re-push the manifest at api.slack.com"
else
  check "Worker URL substituted" "ok"
fi
if grep -q '"is_enabled": true' manifest.json && grep -q '"request_url"' manifest.json; then
  check "Interactivity enabled" "ok"
else
  check "Interactivity enabled" "no" "manifest is missing the interactivity block — re-pull from this repo"
fi
if grep -q '"im:write"' manifest.json; then
  check "Bot scope im:write present" "ok"
else
  check "Bot scope im:write present" "no" "manifest is missing im:write — re-pull from this repo"
fi

# ── reinstall reminder ────────────────────────────────────────────────
echo ""
echo "Slack app"
warn "Reinstall the app if scopes changed" "this PR adds the bot scope \`im:write\`; rerun \`pnpm run install-app\` after re-pushing the manifest so the new scope is granted"

# ── cloudflared ────────────────────────────────────────────────────────
echo ""
echo "tunnel"
if command -v cloudflared >/dev/null 2>&1; then
  check "cloudflared installed" "ok"
else
  check "cloudflared installed" "no" "install from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "All required checks passed. Run \`pnpm run dev:tunnel\` to start."
else
  echo "Some items need attention before the app will run end-to-end."
  exit 1
fi
