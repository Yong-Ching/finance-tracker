#!/bin/bash
# Reviews what a push would publish, and refuses it if anything looks personal.
#
# Two callers:
#   review-push.sh claude      Claude Code PreToolUse hook (.claude/settings.json).
#                              Reads the tool call as JSON on stdin; reviews only
#                              when the Bash command pushes; answers with a
#                              permission decision.
#   review-push.sh pre-push    git pre-push hook (.githooks/pre-push), for pushes
#                              typed in a terminal. Reads git's ref lines on stdin;
#                              exits non-zero to stop the push.
#
# The review has two layers, and both must pass:
#   1. Local and deterministic: paths, identifier formats, and the private
#      strings in .private-patterns + FINANCE_OWNER_NAMES. These never leave
#      the machine.
#   2. A clean reviewer: a separate `claude -p` started in an empty temp dir,
#      so it loads no project CLAUDE.md, no memory and no conversation, with
#      every tool disabled. It sees only the outgoing diff, commit messages
#      and author lines - the same text the push would make public.
#
# It fails closed: if the reviewer cannot run or answer, the push is refused.
# A passed review is remembered for that exact commit, so the git hook does not
# review a second time when Claude's push reaches it.

set -u
mode="${1:-}"
root=$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$root" || exit 0
marks="$(git rev-parse --git-dir)/push-reviewed"
MAX_DIFF_BYTES=600000

# ---- decide what to review ------------------------------------------------

ranges=()
if [ "$mode" = claude ]; then
  cmd=$(jq -r '.tool_input.command // empty')
  # git push, git -C x push, gh repo create --push ... anywhere in a compound command.
  printf '%s' "$cmd" | grep -qE '(^|[;&|(]|\s)git(\s+-C\s+\S+)?\s+push(\s|$)|\sgh\s.*--push(\s|$)|^gh\s.*--push(\s|$)' || exit 0
  head=$(git rev-parse HEAD 2>/dev/null) || exit 0
  if up=$(git rev-parse '@{u}' 2>/dev/null); then
    ranges+=("$up..$head")
  else
    ranges+=("$head --not --remotes")
  fi
elif [ "$mode" = pre-push ]; then
  zero=0000000000000000000000000000000000000000
  while read -r _lref lsha _rref rsha; do
    [ "$lsha" = "$zero" ] && continue # deleting a remote branch publishes nothing
    [ -f "$marks/$lsha" ] && continue # already reviewed and passed
    if [ "$rsha" = "$zero" ]; then
      ranges+=("$lsha --not --remotes")
    else
      ranges+=("$rsha..$lsha")
    fi
  done
  [ ${#ranges[@]} -eq 0 ] && exit 0
else
  echo "usage: review-push.sh claude|pre-push" >&2
  exit 2
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

: >"$work/commits"
for r in "${ranges[@]}"; do
  # shellcheck disable=SC2086 # ranges may carry "--not --remotes"
  git rev-list $r >>"$work/commits" 2>/dev/null
done
sort -u "$work/commits" -o "$work/commits"

refuse() { # $1 = reason
  if [ "$mode" = claude ]; then
    jq -n --arg r "$1" '{hookSpecificOutput: {hookEventName: "PreToolUse",
      permissionDecision: "deny", permissionDecisionReason: $r}}'
    exit 0
  fi
  printf '\npush refused by review-push.sh:\n%s\n\n' "$1" >&2
  exit 1
}

pass() {
  mkdir -p "$marks"
  while read -r c; do : >"$marks/$c"; done <"$work/commits"
  exit 0
}

[ -s "$work/commits" ] || exit 0

# The outgoing change as one patch: from the parent of the oldest new commit
# (or the empty tree, for a first push) to the newest.
newest=$(git rev-list --no-walk $(cat "$work/commits") | head -1)
first=$(git rev-list --reverse $(cat "$work/commits") --not --remotes 2>/dev/null | head -1)
[ -z "$first" ] && first=$(git rev-list --reverse --no-walk $(cat "$work/commits") | head -1)
if base=$(git rev-parse "$first^" 2>/dev/null); then :; else base=$(git hash-object -t tree /dev/null); fi

git diff --name-only --diff-filter=ACMR "$base" "$newest" >"$work/files"
git diff --no-color --diff-filter=ACMR "$base" "$newest" -- . \
  ':(exclude)*package-lock.json' ':(exclude)**/drizzle/meta/**' >"$work/diff"
git log --no-walk --format='commit %h%nauthor: %an <%ae>%ncommitter: %cn <%ce>%n%n%B' \
  $(cat "$work/commits") >"$work/log"

# ---- layer 1: local checks --------------------------------------------------

hits=""
while IFS= read -r f; do
  case "$f" in
    *.pdf|*.PDF|*.db|*.db-*|*.sqlite|*.csv|*.local.json|data/*|*/data/*|sessions/*|CLAUDE.md|.private-patterns)
      hits+="  $f: personal data file"$'\n' ;;
    .env|*/.env|.env.*|*/.env.*)
      case "$f" in *.env.example) ;; *) hits+="  $f: env file"$'\n' ;; esac ;;
  esac
done <"$work/files"

patterns="$work/patterns"
: >"$patterns"
[ -f .private-patterns ] && grep -v '^[[:space:]]*\(#\|$\)' .private-patterns >>"$patterns"
[ -f finance/.env.local ] && grep '^FINANCE_OWNER_NAMES=' finance/.env.local | cut -d= -f2- |
  tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$' >>"$patterns"

# Only added lines can publish something new.
grep '^+' "$work/diff" | grep -v '^+++ ' >"$work/added"
cat "$work/log" >>"$work/added"
if [ -s "$patterns" ]; then
  n=$(grep -ciF -f "$patterns" "$work/added")
  [ "$n" -gt 0 ] && hits+="  $n added line(s) or commit message(s) match .private-patterns / FINANCE_OWNER_NAMES"$'\n'
fi
m=$(grep -E '\b[0-9]{3}-[0-9]{6}-[0-9]\b|\b[STFGM][0-9]{7}[A-Z]\b' "$work/added" | grep -cvE '123-456789-0|T0000000A')
[ "$m" -gt 0 ] && hits+="  $m added line(s) look like a bank account or NRIC/FIN number"$'\n'
if grep -E '^(author|committer): ' "$work/log" | grep -vqE '@users\.noreply\.github\.com>|<noreply@anthropic\.com>'; then
  hits+="  a commit's author/committer email is not a GitHub no-reply address"$'\n'
fi

[ -n "$hits" ] && refuse "Local checks found possible personal data in the outgoing commits:
$hits
Fix the commits (amend or rebase) and push again. Run \`git log -p @{u}..\` to see what is outgoing."

# ---- layer 2: the clean reviewer -------------------------------------------

size=$(($(wc -c <"$work/diff") + $(wc -c <"$work/log")))
[ "$size" -gt "$MAX_DIFF_BYTES" ] && refuse "The outgoing change is ${size} bytes, too large for one review (limit ${MAX_DIFF_BYTES}). Push in smaller pieces."

if [ ! -s "$work/diff" ] && [ ! -s "$work/log" ]; then pass; fi

{
  echo "=== COMMITS (messages and author lines, as they will appear publicly) ==="
  cat "$work/log"
  echo
  echo "=== FILES CHANGED ==="
  cat "$work/files"
  echo
  echo "=== DIFF (package-lock.json and drizzle snapshots omitted) ==="
  cat "$work/diff"
} >"$work/input"

brief='You are a privacy gate for a PUBLIC GitHub repository. The text on stdin is
everything a git push is about to publish: commit messages, author lines, the list
of files changed, and the diff. Decide whether any of it exposes the repo owner'"'"'s
personal or financial information.

The repo is a personal-finance app (statement parsers for DBS, Citibank, YouTrip;
Singapore, SGD). Its code legitimately names banks, merchants (NTUC FP, GRAB,
SHENG SIONG...), categories, and statement formats. Tests are REQUIRED to use
synthetic data: placeholders such as TAN WEI MING, JOHN DOE, JANE ROE,
123-456789-0, 4111111111111111, T0000000A, round or obviously fake amounts.

BLOCK if any added content contains, or very likely contains:
- a real person'"'"'s name tied to the owner'"'"'s money (payees, family, landlord, employer)
- real account, card, NRIC/FIN, tax, policy or transaction reference numbers
- real balances, salary, rent or spending figures read off a statement
- verbatim statement rows or descriptions copied from real data
- email addresses, phone numbers, home addresses, machine usernames or absolute
  home-directory paths
- secrets: API keys, tokens, passwords, .env contents
- personal data files: PDFs, databases, CSV exports, *.local.json fixtures

PASS ordinary code, docs and clearly synthetic test data. When unsure whether a
value is real, BLOCK and say why; a false alarm costs one look, a leak is permanent.

Reply only with the structured verdict. For each finding give the file, the line
(quote a short fragment), and what the problem is.'

schema='{"type":"object","properties":{"verdict":{"type":"string","enum":["pass","block"]},"findings":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"line":{"type":"string"},"issue":{"type":"string"}},"required":["file","issue"]}}},"required":["verdict","findings"]}'

clean=$(mktemp -d)
out=$(cd "$clean" && claude -p --model sonnet --tools "" --strict-mcp-config \
  --no-session-persistence --output-format json --json-schema "$schema" \
  "$brief" <"$work/input" 2>"$work/err")
status=$?
rm -rf "$clean"

verdict=$(printf '%s' "$out" | jq -r '.structured_output.verdict // empty' 2>/dev/null)
if [ $status -ne 0 ] || [ -z "$verdict" ]; then
  refuse "The privacy reviewer could not run, so the push was refused (fail closed).
$(head -c 400 "$work/err")
Check that \`claude\` works in a terminal, then push again."
fi

if [ "$verdict" = pass ]; then
  notes=$(printf '%s' "$out" | jq -r '.structured_output.findings[]? | "  note - \(.file): \(.issue)"')
  [ -n "$notes" ] && [ "$mode" = pre-push ] && printf 'privacy review passed, with notes:\n%s\n' "$notes" >&2
  pass
fi

findings=$(printf '%s' "$out" | jq -r '.structured_output.findings[]? | "  - \(.file)\(if .line then " (\(.line))" else "" end): \(.issue)"')
refuse "The privacy reviewer blocked this push:
$findings

Fix the commits (amend or rebase) and push again. If a finding is a false alarm,
show it to the user and let them decide; do not work around this check."
