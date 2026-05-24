#!/usr/bin/env bash
# raptor-skills — uninstaller
#
# Removes Raptor skills and agent packs installed by install.sh from
# Claude Code, Codex, OpenCode, and Cursor.

set -euo pipefail

REPO="samuelishida/raptor"
CLAUDE_ROOT="$HOME/.claude"
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  CYAN=$'\033[36m'
  RESET=$'\033[0m'
  HIDE_CURSOR=$'\033[?25l'
  SHOW_CURSOR=$'\033[?25h'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; RESET=""
  HIDE_CURSOR=""; SHOW_CURSOR=""
fi

step() { printf '%s→%s %s\n' "${BLUE}" "${RESET}" "$1"; }
warn() { printf '%s!%s %s\n' "${YELLOW}" "${RESET}" "$1"; }
fail() { printf '%s✗%s %s\n' "${RED}" "${RESET}" "$1" >&2; }
hr() { printf '%s──────────────────────────────────────────────────%s\n' "${DIM}" "${RESET}"; }

banner() {
  printf '\n'
  printf '%s' "${CYAN}"
  cat <<'EOF'
  ____             _
 |  _ \ __ _ _ __ | |_ ___  _ __
 | |_) / _` | '_ \| __/ _ \| '__|
 |  _ < (_| | |_) | || (_) | |
 |_| \_\__,_| .__/ \__\___/|_|
            |_|
EOF
  printf '%s\n' "${RESET}"
  printf '   %suninstall%s\n\n' "${DIM}" "${RESET}"
}

boxed() {
  local lines=("$@")
  local maxlen=0
  local strip
  for line in "${lines[@]}"; do
    strip="$(printf '%s' "$line" | sed -E $'s/\033\\[[0-9;?]*[a-zA-Z]//g')"
    (( ${#strip} > maxlen )) && maxlen=${#strip}
  done
  local width=$((maxlen + 4))
  local border
  border="$(printf '─%.0s' $(seq 1 "$width"))"
  printf '%s╭%s╮%s\n' "${DIM}" "$border" "${RESET}"
  for line in "${lines[@]}"; do
    strip="$(printf '%s' "$line" | sed -E $'s/\033\\[[0-9;?]*[a-zA-Z]//g')"
    local pad=$((maxlen - ${#strip}))
    printf '%s│%s  %s%*s  %s│%s\n' "${DIM}" "${RESET}" "$line" "$pad" "" "${DIM}" "${RESET}"
  done
  printf '%s╰%s╯%s\n' "${DIM}" "$border" "${RESET}"
}

cleanup() { printf '%s' "${SHOW_CURSOR}"; }
trap cleanup EXIT INT TERM

dry_run=0
all=0
prefix_filter=""
prefix_filter_set=0
statusline_choice=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --all) all=1; shift ;;
    --prefix)
      if [[ $# -lt 2 ]]; then fail "--prefix requires a value"; exit 2; fi
      prefix_filter="$2"
      prefix_filter_set=1
      shift 2
      ;;
    --statusline) statusline_choice="yes"; shift ;;
    --no-statusline) statusline_choice="no"; shift ;;
    -h|--help)
      banner
      cat <<EOF
${BOLD}Usage${RESET}
  ./uninstall.sh                 interactive: pick which installs to remove
  ./uninstall.sh --dry-run       show plan, do nothing
  ./uninstall.sh --all           remove every detected installation
  ./uninstall.sh --prefix raptor-  scope to a single prefix
  ./uninstall.sh --prefix ""       scope to unprefixed installs
  ./uninstall.sh --statusline      also remove the optional Claude statusline

${BOLD}Detection${RESET}
  Preferred: read the per-target .raptor-install.tsv written by install.sh.
  Fallback: a directory under ~/.claude/skills/, ~/.codex/skills/,
  ~/.opencode/skills/, or ~/.cursor/skills/ ends with one of our skill names
  ${DIM}AND${RESET} its SKILL.md description matches the source's description.

EOF
      exit 0
      ;;
    *) fail "unknown argument: $1"; exit 2 ;;
  esac
done

resolve_script_dir() {
  local source="${BASH_SOURCE[0]:-}"
  [[ -n "$source" ]] || return 1
  [[ "$source" != "bash" ]] || return 1
  [[ "$source" != "/dev/stdin" ]] || return 1

  while [[ -h "$source" ]]; do
    local dir
    dir="$(cd -P "$(dirname "$source")" && pwd)"
    source="$(readlink "$source")"
    [[ "$source" != /* ]] && source="$dir/$source"
  done

  [[ -f "$source" ]] || return 1
  cd -P "$(dirname "$source")" && pwd
}

SCRIPT_DIR="$(resolve_script_dir || true)"
if [[ -z "$SCRIPT_DIR" || ! -d "$SCRIPT_DIR/skills" ]]; then
  fail "uninstall.sh must be run from a Raptor checkout or npm install"
  exit 1
fi

SOURCE_DIR="$SCRIPT_DIR/skills"
AGENTS_SRC="$SCRIPT_DIR/agents"

banner

read_description() {
  local md="$1"
  [[ -f "$md" ]] || { printf ''; return; }
  awk '
    /^---[[:space:]]*$/ { fence++; if (fence == 2) exit; next }
    fence == 1 && /^description:/ {
      sub(/^description:[[:space:]]*/, "")
      sub(/[[:space:]\r]+$/, "")
      print
      exit
    }
  ' "$md"
}

known_names=()
unsorted=()
for src in "$SOURCE_DIR"/*/; do
  n="$(basename "$src")"
  [[ "$n" == _* ]] && continue
  [[ -f "$src/SKILL.md" ]] || continue
  unsorted+=("${#n} $n")
done
while IFS= read -r line; do
  [[ -n "$line" ]] && known_names+=("${line#* }")
done < <(printf '%s\n' "${unsorted[@]}" | sort -rn)

known_descs=()
for i in "${!known_names[@]}"; do
  known_descs[i]="$(read_description "$SOURCE_DIR/${known_names[i]}/SKILL.md")"
done

found_dirs=()
found_platforms=()
found_prefixes=()

scan_manifest_target() {
  local platform="$1"
  local manifest="$2/.raptor-install.tsv"
  [[ -f "$manifest" ]] || return 0

  local line_no=0
  while IFS=$'\t' read -r kind id category target prefix source dest; do
    line_no=$((line_no + 1))
    [[ $line_no -eq 1 ]] && continue
    [[ "$kind" != "skill" ]] && continue
    [[ "$target" == "$platform" ]] || continue
    [[ -n "$dest" ]] || continue
    found_dirs+=("$dest")
    found_platforms+=("$platform")
    found_prefixes+=("$prefix")
  done < "$manifest"
}

scan_target() {
  local platform="$1"
  local target_dir="$2/skills"
  [[ -d "$target_dir" ]] || return 0

  for dir in "$target_dir"/*/; do
    [[ -d "$dir" ]] || continue
    local base
    base="$(basename "$dir")"
    local installed_md="${dir%/}/SKILL.md"
    [[ -f "$installed_md" ]] || continue
    local installed_desc
    installed_desc="$(read_description "$installed_md")"

    for i in "${!known_names[@]}"; do
      local skill="${known_names[i]}"
      local src_desc="${known_descs[i]}"
      if [[ "$base" == *"$skill" ]] && [[ -n "$src_desc" && "$installed_desc" == "$src_desc" ]]; then
        found_dirs+=("${dir%/}")
        found_platforms+=("$platform")
        found_prefixes+=("${base%$skill}")
        break
      fi
    done
  done
}

scan_manifest_target "claude" "$CLAUDE_ROOT"
scan_manifest_target "codex" "$CODEX_ROOT"
scan_manifest_target "opencode" "$OPENCODE_ROOT"
scan_manifest_target "cursor" "$CURSOR_ROOT"

if [[ ${#found_dirs[@]} -eq 0 ]]; then
scan_target "claude" "$CLAUDE_ROOT"
scan_target "codex" "$CODEX_ROOT"
scan_target "opencode" "$OPENCODE_ROOT"
scan_target "cursor" "$CURSOR_ROOT"
fi

if [[ ${#found_dirs[@]} -eq 0 ]]; then
  warn "no Raptor installs found"
  exit 0
fi

if (( prefix_filter_set )); then
  new_dirs=()
  new_platforms=()
  new_prefixes=()
  for i in "${!found_dirs[@]}"; do
    if [[ "${found_prefixes[i]}" == "$prefix_filter" ]]; then
      new_dirs+=("${found_dirs[i]}")
      new_platforms+=("${found_platforms[i]}")
      new_prefixes+=("${found_prefixes[i]}")
    fi
  done
  if [[ ${#new_dirs[@]} -eq 0 ]]; then
    warn "no installs matching prefix \"$prefix_filter\" found"
    exit 0
  fi
  found_dirs=("${new_dirs[@]}")
  found_platforms=("${new_platforms[@]}")
  found_prefixes=("${new_prefixes[@]}")
fi

tty_in=""
if [[ -e /dev/tty ]] && [[ -r /dev/tty ]] && { exec 3</dev/tty; } 2>/dev/null; then
  tty_in="/dev/tty"
fi

interactive=1
if [[ -z "$tty_in" ]] || (( all )) || (( prefix_filter_set )); then
  interactive=0
fi

selected=()
for _ in "${found_dirs[@]}"; do selected+=(1); done

if (( interactive )); then
  cursor=0
  drawn_rows=0

  draw() {
    local rows=0
    printf '   %sChoose installations to uninstall%s  %s↑/↓ move · space toggle · a all · n none · enter confirm · q quit%s\n' \
      "${BOLD}" "${RESET}" "${DIM}" "${RESET}"
    rows=$((rows + 1))
    hr; rows=$((rows + 1))

    local i
    for i in "${!found_dirs[@]}"; do
      local box pointer label
      if (( selected[i] )); then box="${RED}[✓]${RESET}"; else box="${DIM}[ ]${RESET}"; fi
      if (( i == cursor )); then pointer="${CYAN}❯${RESET}"; else pointer=" "; fi
      label="${found_platforms[i]}:$(basename "${found_dirs[i]}")"
      printf '   %s %s %s\n' "$pointer" "$box" "$label"
      rows=$((rows + 1))
    done
    hr; rows=$((rows + 1))
    printf '   %sremove from:%s %s\n' "${DIM}" "${RESET}" "${found_dirs[cursor]}"
    rows=$((rows + 1))
    drawn_rows=$rows
  }

  if (( ${BASH_VERSINFO[0]:-3} >= 4 )); then
    esc_timeout="0.05"
  else
    esc_timeout="1"
  fi

  read_key() {
    local k
    IFS= read -rsn1 k <"$tty_in"
    if [[ "$k" == $'\033' ]]; then
      local rest=""
      IFS= read -rsn2 -t "$esc_timeout" rest <"$tty_in" || rest=""
      k="$k$rest"
    fi
    printf '%s' "$k"
  }

  printf '%s' "${HIDE_CURSOR}"
  draw
  while true; do
    key="$(read_key)"
    case "$key" in
      $'\033[A'|k) (( cursor > 0 )) && cursor=$((cursor - 1)) ;;
      $'\033[B'|j) (( cursor < ${#found_dirs[@]} - 1 )) && cursor=$((cursor + 1)) ;;
      ' ') selected[cursor]=$((1 - selected[cursor])) ;;
      a|A) for i in "${!selected[@]}"; do selected[i]=1; done ;;
      n|N) for i in "${!selected[@]}"; do selected[i]=0; done ;;
      ''|$'\n'|$'\r') break ;;
      q|Q) printf '%s' "${SHOW_CURSOR}"; warn "aborted"; exit 130 ;;
    esac
    printf '\033[%dA\033[J' "$drawn_rows"
    draw
  done
  printf '%s' "${SHOW_CURSOR}"
  printf '\n'
fi

remove_selected_from_target() {
  local platform="$1"
  local target_dir="$2/skills"
  local count=0
  [[ -d "$target_dir" ]] || return 0

  if (( dry_run )); then
    step "Planning ${platform} uninstall ← ${BOLD}${target_dir}${RESET}"
  else
    step "Uninstalling ${platform} ← ${BOLD}${target_dir}${RESET}"
  fi
  hr

  for i in "${!found_dirs[@]}"; do
    (( selected[i] )) || continue
    [[ "${found_platforms[i]}" == "$platform" ]] || continue
    local dir="${found_dirs[i]}"
    local label
    label="$(basename "$dir")"
    if (( dry_run )); then
      printf '   %s−%s %s %s(would remove)%s\n' "${YELLOW}" "${RESET}" "$label" "${DIM}" "${RESET}"
    else
      rm -rf "$dir"
      printf '   %s−%s %s\n' "${YELLOW}" "${RESET}" "$label"
    fi
    count=$((count + 1))
  done

  hr
  REMOVAL_COUNTS+=("${platform}:${count}")
}

remove_agents_from_target() {
  local platform="$1"
  local target_dir="$2/agents"
  local removed=0
  local manifest="$2/.raptor-install.tsv"
  [[ -d "$target_dir" ]] || { AGENT_COUNTS+=("${platform}:0"); return 0; }

  local allowed_prefixes=()
  for i in "${!found_dirs[@]}"; do
    (( selected[i] )) || continue
    [[ "${found_platforms[i]}" == "$platform" ]] || continue
    allowed_prefixes+=("${found_prefixes[i]}")
  done

  if [[ ${#allowed_prefixes[@]} -eq 0 ]]; then
    AGENT_COUNTS+=("${platform}:0")
    return 0
  fi

  pending_remove=()
  if [[ -f "$manifest" ]]; then
    local line_no=0
    while IFS=$'\t' read -r kind id category target prefix source dest; do
      line_no=$((line_no + 1))
      [[ $line_no -eq 1 ]] && continue
      [[ "$kind" == "agent" && "$target" == "$platform" ]] || continue
      for allowed_prefix in "${allowed_prefixes[@]}"; do
        if [[ "$prefix" == "$allowed_prefix" && -f "$dest" ]]; then
          pending_remove+=("$dest")
          break
        fi
      done
    done < "$manifest"
  else
    src_agent_names=()
    src_agent_descs=()
    for src in "$AGENTS_SRC"/*.md; do
      [[ -f "$src" ]] || continue
      src_agent_names+=("$(basename "$src" .md)")
      src_agent_descs+=("$(read_description "$src")")
    done

    for installed in "$target_dir"/*.md; do
      [[ -f "$installed" ]] || continue
      base="$(basename "$installed" .md)"
      inst_desc="$(read_description "$installed")"
      for i in "${!src_agent_names[@]}"; do
        sname="${src_agent_names[i]}"
        sdesc="${src_agent_descs[i]}"
        if [[ "$base" == *"$sname" ]]; then
          installed_prefix="${base%$sname}"
          for allowed_prefix in "${allowed_prefixes[@]}"; do
            if [[ "$installed_prefix" == "$allowed_prefix" && -n "$sdesc" && "$inst_desc" == "$sdesc" ]]; then
              pending_remove+=("$installed")
              continue 3
            fi
          done
        fi
      done
    done
  fi

  if (( ${#pending_remove[@]} > 0 )); then
    if (( dry_run )); then
      step "Planning ${platform} agents removal ← ${BOLD}${target_dir}${RESET}"
    else
      step "Removing ${platform} agents ← ${BOLD}${target_dir}${RESET}"
    fi
    hr
    for f in "${pending_remove[@]}"; do
      if (( dry_run )); then
        printf '   %s−%s %s %s(would remove)%s\n' "${YELLOW}" "${RESET}" "$(basename "$f")" "${DIM}" "${RESET}"
      else
        rm -f "$f"
        printf '   %s−%s %s\n' "${YELLOW}" "${RESET}" "$(basename "$f")"
      fi
      removed=$((removed + 1))
    done
    hr
  fi

  AGENT_COUNTS+=("${platform}:${removed}")
}

REMOVAL_COUNTS=()
AGENT_COUNTS=()
remove_selected_from_target "claude" "$CLAUDE_ROOT"
printf '\n'
remove_agents_from_target "claude" "$CLAUDE_ROOT"
printf '\n'
remove_selected_from_target "codex" "$CODEX_ROOT"
printf '\n'
remove_agents_from_target "codex" "$CODEX_ROOT"
printf '\n'
remove_selected_from_target "opencode" "$OPENCODE_ROOT"
printf '\n'
remove_agents_from_target "opencode" "$OPENCODE_ROOT"
printf '\n'
remove_selected_from_target "cursor" "$CURSOR_ROOT"
printf '\n'
remove_agents_from_target "cursor" "$CURSOR_ROOT"

statusline_dest="$CLAUDE_ROOT/raptor-statusline.sh"
statusline_settings="$CLAUDE_ROOT/settings.json"
statusline_present=0
[[ -f "$statusline_dest" ]] && statusline_present=1

if (( statusline_present )) && (( interactive )) && [[ -z "$statusline_choice" ]]; then
  printf '\n'
  printf '   %sAlso remove the raptor statusline?%s %s(%s)%s\n' \
    "${BOLD}" "${RESET}" "${DIM}" "$statusline_dest" "${RESET}"
  printf '\n   %sremove? [y/N]>%s ' "${CYAN}" "${RESET}"
  IFS= read -r reply <"$tty_in" || reply=""
  case "$reply" in
    y|Y|yes|YES) statusline_choice="yes" ;;
    *) statusline_choice="no" ;;
  esac
  printf '\n'
fi

statusline_removed=0
if [[ "$statusline_choice" == "yes" ]]; then
  if (( dry_run )); then
    step "Planning statusline removal"
  else
    step "Removing statusline"
  fi
  hr
  if (( statusline_present )); then
    if (( dry_run )); then
      printf '   %s−%s raptor-statusline.sh %s(would remove)%s\n' "${YELLOW}" "${RESET}" "${DIM}" "${RESET}"
    else
      rm -f "$statusline_dest"
      printf '   %s−%s raptor-statusline.sh\n' "${YELLOW}" "${RESET}"
    fi
    statusline_removed=1
  else
    printf '   %s·%s raptor-statusline.sh %s(not present)%s\n' "${DIM}" "${RESET}" "${DIM}" "${RESET}"
  fi

  if [[ -f "$statusline_settings" ]] && command -v jq >/dev/null 2>&1 \
     && jq -e '.statusLine.command // "" | test("raptor-statusline\\.sh")' \
       "$statusline_settings" >/dev/null 2>&1; then
    if (( dry_run )); then
      printf '   %s−%s settings.json statusLine %s(would clear)%s\n' "${YELLOW}" "${RESET}" "${DIM}" "${RESET}"
    else
      tmp="$(mktemp -- "$CLAUDE_ROOT/.settings.XXXXXX")"
      if jq '
        if .statusLine? then
          .statusLine |= (del(.command, .type))
          | if (.statusLine | type == "object" and (.statusLine | length) == 0) then del(.statusLine) else . end
        else
          .
        end
      ' "$statusline_settings" >"$tmp" 2>/dev/null; then
        cp "$statusline_settings" "${statusline_settings}.bak.$(date +%s)-$$"
        mv "$tmp" "$statusline_settings"
        printf '   %s−%s settings.json statusLine cleaned %s(prev backed up)%s\n' "${YELLOW}" "${RESET}" "${DIM}" "${RESET}"
      else
        rm -f "$tmp"
        warn "could not edit settings.json — left untouched"
      fi
    fi
  fi
  hr
fi

printf '\n'
summary_lines=()
if (( dry_run )); then
  summary_lines+=("${BOLD}Dry-run complete${RESET}")
else
  summary_lines+=("${GREEN}✓${RESET} ${BOLD}Raptor uninstall complete${RESET}")
fi

for target_info in "${REMOVAL_COUNTS[@]}"; do
  IFS=':' read -r platform count <<<"$target_info"
  for agent_info in "${AGENT_COUNTS[@]}"; do
    IFS=':' read -r agent_platform agent_count <<<"$agent_info"
    [[ "$platform" == "$agent_platform" ]] || continue
    if (( dry_run )); then
      summary_lines+=("${BOLD}${platform}${RESET}  ${DIM}${count} skill(s) and ${agent_count} agent(s) would be removed${RESET}")
    else
      summary_lines+=("${BOLD}${platform}${RESET}  ${DIM}${count} skill(s) and ${agent_count} agent(s) removed${RESET}")
    fi
  done
done

if (( statusline_removed )); then
  summary_lines+=("" "${BOLD}Statusline${RESET}  ${DIM}${statusline_dest}${RESET}")
fi

summary_lines+=("" "${BOLD}Docs${RESET}  ${DIM}https://github.com/${REPO}${RESET}")
boxed "${summary_lines[@]}"
printf '\n'
