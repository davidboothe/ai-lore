#!/bin/bash
# Claude Code status line — docs "status bar" style:
# [Model] repo (branch)  [███░░░░░░░] NN% used/max  ⚡cache  +A -R  ⏱dur  $cost
#
# DESIGN REFERENCE. The shipped, cross-platform renderer is scripts/statusline.js
# (zero-dependency Node, no jq/bash needed) and it reproduces this script's output
# byte-for-byte. This .sh is kept as the human-readable spec for that look — if you
# change the look here, mirror it in statusline.js and keep the parity diff green
# (see README "How it works"). setup.js installs statusline.js, never this file.
input=$(cat)

model=$(echo "$input" | jq -r '.model.display_name // "Unknown"')
used=$(echo "$input"  | jq -r '.context_window.used_percentage // empty')
tok=$(echo "$input"   | jq -r '.context_window.total_input_tokens // empty')
max=$(echo "$input"   | jq -r '.context_window.context_window_size // empty')
cache=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // empty')
cost=$(echo "$input"  | jq -r '.cost.total_cost_usd // 0')
dur_ms=$(echo "$input" | jq -r '.cost.total_duration_ms // empty')
added=$(echo "$input" | jq -r '.cost.total_lines_added // empty')
removed=$(echo "$input" | jq -r '.cost.total_lines_removed // empty')
cwd=$(echo "$input"   | jq -r '.workspace.current_dir // .cwd // ""')

# Git repo + branch (skip optional locks so we never write to the repo)
branch=""; repo=""
if [ -n "$cwd" ] && git -C "$cwd" --no-optional-locks rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
  repo=$(basename "$(git -C "$cwd" --no-optional-locks rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null)
fi
[ -z "$repo" ] && repo=$(basename "$cwd")

# Compact token formatter: 470000 -> 470k, 1000000 -> 1.0M
fmt_tokens() {
  awk -v n="$1" 'BEGIN{
    if (n >= 1000000) printf "%.1fM", n/1000000;
    else if (n >= 1000) printf "%.0fk", n/1000;
    else printf "%d", n;
  }'
}

# Duration formatter: ms -> 45s / 12m / 1h5m
fmt_dur() {
  local s=$(( $1 / 1000 ))
  if   [ "$s" -ge 3600 ]; then printf '%dh%dm' $((s/3600)) $(((s%3600)/60))
  elif [ "$s" -ge 60 ];   then printf '%dm' $((s/60))
  else printf '%ds' "$s"; fi
}

# Colors — bold + bright so they stay vivid in the dimmed status-line area
RESET="\033[0m"
CYAN="\033[1;96m"; YELLOW="\033[1;93m"; GREEN="\033[1;92m"; RED="\033[1;91m"
BLUE="\033[1;94m"; MAGENTA="\033[1;95m"; WHITE="\033[1;97m"

# Context-usage bar (10 cells) + used/max tokens, colored by fill level
if [ -n "$used" ]; then
  used_int=$(printf '%.0f' "$used")
  filled=$((used_int / 10)); empty=$((10 - filled))
  bar=""
  for ((i=0; i<filled; i++)); do bar="${bar}█"; done
  for ((i=0; i<empty;  i++)); do bar="${bar}░"; done
  ctx="[$bar] ${used_int}%"
  if [ -n "$tok" ] && [ -n "$max" ]; then
    ctx="$ctx $(fmt_tokens "$tok")/$(fmt_tokens "$max")"
  fi
  # Alert color: green <60, yellow 60-79, red >=80
  if   [ "$used_int" -ge 80 ]; then CTX_COLOR="$RED"
  elif [ "$used_int" -ge 60 ]; then CTX_COLOR="$YELLOW"
  else CTX_COLOR="$GREEN"; fi
else
  ctx="[░░░░░░░░░░] --%"; CTX_COLOR="$GREEN"
fi

cost_fmt=$(printf '$%.2f' "$cost")

# --- assemble line ---
out="${CYAN}[%s]${RESET} ${YELLOW}%s${RESET}"
args=("$model" "$repo")

if [ -n "$branch" ]; then
  out="$out ${GREEN}(%s)${RESET}"; args+=("$branch")
fi

out="$out  ${CTX_COLOR}%s${RESET}"; args+=("$ctx")

if [ -n "$cache" ]; then
  out="$out  ${MAGENTA}cache-read ⚡ %s${RESET}"; args+=("$(fmt_tokens "$cache")")
fi

if [ -n "$added" ] && [ -n "$removed" ]; then
  out="$out  ${GREEN}+%s${RESET} ${RED}-%s${RESET}"; args+=("$added" "$removed")
fi

if [ -n "$dur_ms" ]; then
  out="$out  ${BLUE}⏱ %s${RESET}"; args+=("$(fmt_dur "$dur_ms")")
fi

out="$out  ${WHITE}%s${RESET}"; args+=("$cost_fmt")

# shellcheck disable=SC2059
printf "$out" "${args[@]}"
