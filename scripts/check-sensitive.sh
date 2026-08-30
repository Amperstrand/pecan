#!/bin/sh
# Block commits containing phone numbers or other sensitive personal data.
# Run manually or wire as a pre-commit hook:
#   ln -s ../../scripts/check-sensitive.sh .git/hooks/pre-commit
set -eu
cd "$(dirname "$0")/.."

# Norwegian mobile patterns (8 digits starting with 4 or 9) and generic
# sensitive strings. Known-safe numbers (test dummies) go in the allowlist.
ALLOWLIST="44000001|44444444"

FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || git ls-files)
[ -z "$FILES" ] && exit 0

FOUND=$(echo "$FILES" | while read -r f; do
  [ -f "$f" ] || continue
  grep -nE "[^0-9](4[0-9]{7}|9[0-9]{7})[^0-9]" "$f" 2>/dev/null |
    grep -vE "$ALLOWLIST" |
    sed "s|^|$f:|"
done)

if [ -n "$FOUND" ]; then
  echo "✋ SENSITIVE DATA DETECTED — phone-number-like strings found:" >&2
  echo "$FOUND" >&2
  echo "" >&2
  echo "If these are dummy/test numbers, add them to the allowlist in" >&2
  echo "scripts/check-sensitive.sh. Otherwise remove the data and re-commit." >&2
  exit 1
fi

exit 0
