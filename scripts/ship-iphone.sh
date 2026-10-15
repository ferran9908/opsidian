#!/usr/bin/env bash
# Gets the iPhone app's latest code to its users, as T3 Code does. Run by CI after every push
# that changes the app; it can be run by hand from the repository root with EXPO_TOKEN set.
#
# The fingerprint is a hash of the app's native side. If a finished TestFlight build already has
# it, this change is JavaScript only: it goes out over the air, and installed apps pick it up the
# next time they open. If no build has it, the native side changed: a new build is made and sent
# to TestFlight. While that build is still running, the update waits for the next push.
set -euo pipefail
cd apps/mobile

eas() { npx --yes eas-cli@latest "$@"; }
summary() { echo "$1"; [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$1" >> "$GITHUB_STEP_SUMMARY" || true; }

json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(eval("JSON.parse(s)"+process.argv[1])))' "$1"; }
version=$(npx expo config --json --type public | json .version)
message="$(git log -1 --pretty=%s | head -c 120) ($(git rev-parse --short=9 HEAD))"
hash=$(eas fingerprint:generate --platform ios --environment production --json --non-interactive \
  | sed -n '/^{/,$p' | json .hash)
builds=$(eas build:list --platform ios --build-profile production --fingerprint-hash "$hash" --limit 20 --json --non-interactive)
count() { node -e "const b=JSON.parse(process.argv[1]);console.log(b.filter(x=>process.argv.slice(2).includes(x.status)).length)" "$builds" "$@"; }
finished=$(count FINISHED)
active=$(count NEW IN_QUEUE IN_PROGRESS)
errored=$(count ERRORED)
latest=$(eas build:list --platform ios --build-profile production --limit 1 --json --non-interactive \
  | json '[0]?.appVersion ?? "none"')

if [ "$finished" -gt 0 ]; then
  eas update --channel production --environment production --platform ios --message "$message" --non-interactive
  summary "✅ Sent over the air to iPhones on fingerprint \`$hash\`."
fi

reason=""
if [ -n "${FORCE_BUILD:-}" ] && [ "$active" -eq 0 ]; then
  # Run by hand: build again, whatever happened to earlier builds (for example, one failed).
  reason="asked for by hand"
elif [ "$finished" -eq 0 ] && [ "$active" -eq 0 ]; then
  if [ "$errored" -gt 0 ]; then
    summary "❌ The build for fingerprint \`$hash\` failed. Fix it, then run the Release workflow by hand, which builds again."
    exit 1
  fi
  reason="no build has native fingerprint $hash"
elif [ "$latest" != "$version" ] && [ "$active" -eq 0 ]; then
  reason="the latest build is $latest and app.config.ts says $version"
fi

if [ -z "$reason" ]; then
  [ "$finished" -eq 0 ] && summary "⏳ A build for fingerprint \`$hash\` is still running; the update goes out after it."
  exit 0
fi
eas build --platform ios --profile production --auto-submit --non-interactive --no-wait
summary "🏗️ Building $version for TestFlight: $reason."
