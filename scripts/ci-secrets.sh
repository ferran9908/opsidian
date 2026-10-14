#!/usr/bin/env bash
# Stores what CI needs to sign and notarise the Mac app as GitHub Actions secrets.
# Run it on the Mac that makes releases, from the repository root. Values go straight from this
# Mac to GitHub; nothing is printed or written to the repository. See docs/release.md.
set -euo pipefail

repo=ferran9908/opsidian
env_file=apps/desktop/.env.local

gh auth status >/dev/null 2>&1 || { echo "Sign in to the GitHub CLI first: gh auth login"; exit 1; }
[ -f "$env_file" ] || { echo "Missing $env_file (see docs/release.md)."; exit 1; }

value() { grep -E "^$1=" "$env_file" | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
key_path=$(value APPLE_API_KEY); key_path=${key_path/#\~/$HOME}
key_id=$(value APPLE_API_KEY_ID)
issuer=$(value APPLE_API_ISSUER)
[ -f "$key_path" ] || { echo "APPLE_API_KEY in $env_file points to $key_path, which does not exist."; exit 1; }

cat <<'EOF'

CI also needs your Developer ID certificate as a .p12 file:
  1. Open Keychain Access → login → My Certificates.
  2. Right-click "Developer ID Application: …" → Export…
  3. Save it as a .p12 (for example ~/Desktop/developer-id.p12) and choose a password.

EOF
read -r -p "Path to the .p12 file: " p12
p12=${p12/#\~/$HOME}
[ -f "$p12" ] || { echo "No file at $p12."; exit 1; }
read -r -s -p "Its password: " p12_password; echo

base64 -i "$p12" | gh secret set CSC_LINK -R "$repo"
printf '%s' "$p12_password" | gh secret set CSC_KEY_PASSWORD -R "$repo"
gh secret set APPLE_API_KEY -R "$repo" < "$key_path"
printf '%s' "$key_id" | gh secret set APPLE_API_KEY_ID -R "$repo"
printf '%s' "$issuer" | gh secret set APPLE_API_ISSUER -R "$repo"

echo
echo "Stored. GitHub now has:"
gh secret list -R "$repo"
echo
echo "You can delete $p12 now; GitHub keeps its own copy."
