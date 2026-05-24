#!/usr/bin/env bash
# raptor-skills — opinionated AI coding skills
#
# https://github.com/samuelishida/raptor
#
# Quick install (no clone required):
#   curl -fsSL https://raw.githubusercontent.com/samuelishida/raptor/main/install.sh | bash
#
# With flags:
#   curl -fsSL .../install.sh | bash -s -- --select
#   curl -fsSL .../install.sh | bash -s -- --dry-run
#   curl -fsSL .../install.sh | bash -s -- --only code-audit
#   curl -fsSL .../install.sh | bash -s -- --prefix raptor-
#
# From a cloned checkout or npm install:
#   ./install.sh
#   raptor-install

set -euo pipefail

REPO="samuelishida/raptor"
BRANCH="main"
TARBALL_URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"
CLAUDE_ROOT="$HOME/.claude"
CODEX_ROOT="${CODEX_HOME:-$HOME/.codex}"
OPENCODE_ROOT="${OPENCODE_HOME:-$HOME/.opencode}"
CURSOR_ROOT="${CURSOR_HOME:-$HOME/.cursor}"

# ─── colors ────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  BOLD=$'\033[1m'
  DIM=$'\033[2m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  MAG=$'\033[35m'
  CYAN=$'\033[36m'
  GREY=$'\033[90m'
  RESET=$'\033[0m'
  HIDE_CURSOR=$'\033[?25l'
  SHOW_CURSOR=$'\033[?25h'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; MAG=""; CYAN=""; GREY=""; RESET=""
  HIDE_CURSOR=""; SHOW_CURSOR=""
fi

step() { printf '%s→%s %s\n' "${BLUE}" "${RESET}" "$1"; }
ok() { printf '%s✓%s %s\n' "${GREEN}" "${RESET}" "$1"; }
warn() { printf '%s!%s %s\n' "${YELLOW}" "${RESET}" "$1"; }
fail() { printf '%s✗%s %s\n' "${RED}" "${RESET}" "$1" >&2; }
sub() { printf '   %s%s%s\n' "${DIM}" "$1" "${RESET}"; }
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
  printf '   %sskills for Claude, Codex, opencode, Cursor%s\n\n' "${DIM}" "${RESET}"
}

spinner() {
  local pid=$1
  local msg=$2
  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  local i=0
  printf '%s' "${HIDE_CURSOR}"
  while kill -0 "$pid" 2>/dev/null; do
    local frame="${frames:$((i % ${#frames})):1}"
    printf '\r\033[K  %s%s%s %s' "${CYAN}" "$frame" "${RESET}" "$msg"
    i=$((i + 1))
    sleep 0.08
  done
  printf '\r\033[K'
  printf '%s' "${SHOW_CURSOR}"
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

TMPDIR_CLEANUP=""
cleanup() {
  printf '%s' "${SHOW_CURSOR}"
  if [[ -n "$TMPDIR_CLEANUP" && -d "$TMPDIR_CLEANUP" ]]; then
    rm -rf "$TMPDIR_CLEANUP"
  fi
}
trap cleanup EXIT INT TERM

# ─── arg parsing ───────────────────────────────────────────────────────────────

dry_run=0
only_list=()
prefix=""
prefix_set=0           # 1 = user supplied --prefix (skip interactive prompt)
statusline_choice=""   # "" = ask interactively, "yes" / "no" otherwise
profile="core"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --only)
      if [[ $# -lt 2 ]]; then fail "--only requires a skill name"; exit 2; fi
      only_list+=("$2")
      shift 2
      ;;
    --statusline)    statusline_choice="yes"; shift ;;
    --no-statusline) statusline_choice="no";  shift ;;
    --profile)
      if [[ $# -lt 2 ]]; then fail "--profile requires a value (core or all)"; exit 2; fi
      case "$2" in
        core|all) profile="$2" ;;
        *) fail "--profile must be either core or all (got '$2')"; exit 2 ;;
      esac
      shift 2
      ;;
    --prefix)
      if [[ $# -lt 2 ]]; then fail "--prefix requires a value (use --prefix '' for none)"; exit 2; fi
      case "$2" in
        --*) fail "--prefix value cannot start with -- (got '$2'; use --prefix '' for none)"; exit 2 ;;
      esac
      # Block characters that would break sed regex/replacement, filenames,
      # or shell quoting. Allows letters, digits, _, -, :, . — covers the
      # common namespace styles (`raptor-`, `r:`, `my.org.`).
      if [[ -n "$2" && ! "$2" =~ ^[a-zA-Z0-9_:.\-]+$ ]]; then
        fail "--prefix may only contain letters, digits, '_', '-', ':', '.' (got '$2')"
        exit 2
      fi
      prefix="$2"
      prefix_set=1
      shift 2
      ;;
    -h|--help)
      banner
      cat <<EOF
${BOLD}Usage${RESET}
  ./install.sh                       interactive: pick a prefix, then choose skills
  ./install.sh --dry-run             show plan, do not install
  ./install.sh --only <name>         install one skill, no prompts (repeatable)
  ./install.sh --prefix <p>          namespace skills + agents (e.g. raptor-, r:)
                                     allowed: letters/digits/_/-/:/. or '' for none
  ./install.sh --profile core        install only the core orchestrator surface (default)
  ./install.sh --profile all         install every packaged skill and agent
  ./install.sh --statusline          also install the raptor statusline
  ./install.sh --no-statusline       skip the statusline prompt

${BOLD}Targets${RESET}
  Claude Code: ${CLAUDE_ROOT}
  Codex:       ${CODEX_ROOT}
  opencode:    ${OPENCODE_ROOT}
  Cursor:      ${CURSOR_ROOT}

${BOLD}Remote (no clone required)${RESET}
  curl -fsSL https://raw.githubusercontent.com/${REPO}/${BRANCH}/install.sh | bash

EOF
      exit 0
      ;;
    *) fail "unknown argument: $1"; exit 2 ;;
  esac
done

# ─── locate source ─────────────────────────────────────────────────────────────

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

banner

if [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/skills" ]]; then
  SOURCE_DIR="$SCRIPT_DIR/skills"
  REPO_ROOT="$SCRIPT_DIR"
  sub "source: local checkout"
else
  if ! command -v curl >/dev/null 2>&1; then fail "curl is required"; exit 1; fi
  if ! command -v tar >/dev/null 2>&1; then fail "tar is required"; exit 1; fi
  TMPDIR_CLEANUP="$(mktemp -d -t raptor-skills.XXXXXX)"
  curl -fsSL "$TARBALL_URL" -o "$TMPDIR_CLEANUP/repo.tar.gz" &
  curl_pid=$!
  spinner "$curl_pid" "Fetching from github.com/${REPO}@${BRANCH}…"
  if ! wait "$curl_pid"; then
    fail "could not download $TARBALL_URL"
    exit 1
  fi
  ok "Downloaded"
  tar -xzf "$TMPDIR_CLEANUP/repo.tar.gz" -C "$TMPDIR_CLEANUP"
  extracted="$(find "$TMPDIR_CLEANUP" -maxdepth 1 -type d -name "raptor-*" | head -n 1)"
  if [[ -z "$extracted" || ! -d "$extracted/skills" ]]; then
    fail "could not locate skills/ in downloaded tarball"
    exit 1
  fi
  SOURCE_DIR="$extracted/skills"
  REPO_ROOT="$extracted"
fi

AGENTS_SRC="$REPO_ROOT/agents"
STATUSLINE_SRC="$REPO_ROOT/statusline/statusline.sh"

mkdir -p "$CLAUDE_ROOT/skills" "$CLAUDE_ROOT/agents"
mkdir -p "$CODEX_ROOT/skills" "$CODEX_ROOT/agents"
mkdir -p "$OPENCODE_ROOT/skills" "$OPENCODE_ROOT/agents"
mkdir -p "$CURSOR_ROOT/skills" "$CURSOR_ROOT/agents"

MANIFEST_DIR="$REPO_ROOT/catalog"
SKILLS_MANIFEST="$MANIFEST_DIR/skills.tsv"
AGENTS_MANIFEST="$MANIFEST_DIR/agents.tsv"

skills=()
descriptions=()
skill_default_flags=()
skill_categories=()
skill_targets=()
agent_names=()
agent_categories=()
agent_default_flags=()
agent_targets=()

load_manifest() {
  local manifest="$1"
  local kind="$2"
  local line_no=0
  while IFS=$'\t' read -r id category default_install targets; do
    line_no=$((line_no + 1))
    [[ $line_no -eq 1 ]] && continue
    [[ -z "${id:-}" ]] && continue
    case "$kind" in
      skill)
        skills+=("$id")
        skill_categories+=("$category")
        skill_default_flags+=("$default_install")
        skill_targets+=("$targets")
        ;;
      agent)
        agent_names+=("$id")
        agent_categories+=("$category")
        agent_default_flags+=("$default_install")
        agent_targets+=("$targets")
        ;;
    esac
  done < "$manifest"
}

load_manifest "$SKILLS_MANIFEST" skill
load_manifest "$AGENTS_MANIFEST" agent

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

skill_skill_paths=()
for name in "${skills[@]}"; do
  skill_skill_paths+=("$SOURCE_DIR/$name/SKILL.md")
  descriptions+=("$(read_description "$SOURCE_DIR/$name/SKILL.md")")
done

if [[ ${#skills[@]} -eq 0 ]]; then
  fail "no skills found in $SOURCE_DIR"
  exit 1
fi

tty_in=""
if [[ -e /dev/tty ]] && [[ -r /dev/tty ]] && { exec 3</dev/tty; } 2>/dev/null; then
  tty_in="/dev/tty"
fi

interactive=1
if [[ -z "$tty_in" ]] || [[ ${#only_list[@]} -gt 0 ]]; then
  interactive=0
fi

if [[ ${#only_list[@]} -eq 0 && $interactive -eq 0 ]]; then
  for i in "${!skills[@]}"; do
    if [[ "$profile" == "all" || "${skill_default_flags[i]}" == "true" ]]; then
      only_list+=("${skills[i]}")
    fi
  done
fi

if (( interactive )) && ! (( prefix_set )); then
  printf '\n'
  printf '   %sNamespace prefix?%s %s(optional — press enter for none)%s\n' \
    "${BOLD}" "${RESET}" "${DIM}" "${RESET}"
  printf '   %slets these skills coexist with same-named project skills%s\n' \
    "${DIM}" "${RESET}"
  printf '   %sex: prefix %sraptor-%s installs %scap%s as %sraptor-cap%s\n' \
    "${DIM}" "${BOLD}" "${RESET}${DIM}" "${BOLD}" "${RESET}${DIM}" "${BOLD}" "${RESET}"
  printf '\n   %sprefix>%s ' "${CYAN}" "${RESET}"
  IFS= read -r prefix <"$tty_in" || prefix=""
  prefix="${prefix#"${prefix%%[![:space:]]*}"}"
  prefix="${prefix%"${prefix##*[![:space:]]}"}"
  if [[ -n "$prefix" && ! "$prefix" =~ ^[a-zA-Z0-9_:.\-]+$ ]]; then
    fail "prefix may only contain letters, digits, '_', '-', ':', '.' (got '$prefix')"
    exit 2
  fi
  printf '\n'
fi

if (( interactive )); then
  selected=()
  for i in "${!skills[@]}"; do
    if [[ "$profile" == "all" || "${skill_default_flags[i]}" == "true" ]]; then
      selected+=(1)
    else
      selected+=(0)
    fi
  done
  cursor=0
  term_cols="${COLUMNS:-0}"
  if (( term_cols == 0 )) && command -v tput >/dev/null 2>&1; then
    term_cols="$(tput cols </dev/tty 2>/dev/null || echo 0)"
  fi
  (( term_cols == 0 )) && term_cols=100
  wrap_width=$((term_cols - 6))
  (( wrap_width < 30 )) && wrap_width=30
  drawn_rows=0

  draw() {
    local rows=0
    printf '   %sChoose which skills to install%s  %s↑/↓ move · space toggle · a all · n none · enter confirm · q quit%s\n' \
      "${BOLD}" "${RESET}" "${DIM}" "${RESET}"
    rows=$((rows + 1))
    hr; rows=$((rows + 1))

    local i=0
    local box pointer
    for name in "${skills[@]}"; do
      if (( selected[i] )); then box="${GREEN}[✓]${RESET}"; else box="${DIM}[ ]${RESET}"; fi
      if (( i == cursor )); then pointer="${CYAN}❯${RESET}"; else pointer=" "; fi
      printf '   %s %s %s\n' "$pointer" "$box" "$name"
      rows=$((rows + 1))
      i=$((i + 1))
    done
    hr; rows=$((rows + 1))

    local desc="${descriptions[cursor]}"
    if [[ -n "$desc" ]]; then
      local line
      while IFS= read -r line; do
        printf '   %s%s%s\n' "${DIM}" "$line" "${RESET}"
        rows=$((rows + 1))
      done < <(printf '%s\n' "$desc" | fold -s -w "$wrap_width")
    else
      printf '   %s(no description)%s\n' "${DIM}" "${RESET}"
      rows=$((rows + 1))
    fi

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
      $'\033[B'|j) (( cursor < ${#skills[@]} - 1 )) && cursor=$((cursor + 1)) ;;
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

  only_list=()
  for i in "${!skills[@]}"; do
    (( selected[i] )) && only_list+=("${skills[i]}")
  done
  if [[ ${#only_list[@]} -eq 0 ]]; then
    warn "no skills selected — exiting"
    exit 0
  fi
fi

if (( interactive )) && [[ -z "$statusline_choice" ]] && [[ -f "$STATUSLINE_SRC" ]]; then
  printf '\n'
  printf '   %sInstall the raptor statusline?%s %s(Claude Code only)%s\n' \
    "${BOLD}" "${RESET}" "${DIM}" "${RESET}"
  printf '   %swrites ~/.claude/raptor-statusline.sh and updates ~/.claude/settings.json%s\n' \
    "${DIM}" "${RESET}"
  printf '\n   %sinstall? [y/N]>%s ' "${CYAN}" "${RESET}"
  IFS= read -r reply <"$tty_in" || reply=""
  case "$reply" in
    y|Y|yes|YES) statusline_choice="yes" ;;
    *) statusline_choice="no" ;;
  esac
  printf '\n'
fi

should_install() {
  local name="$1"
  if [[ ${#only_list[@]} -eq 0 ]]; then return 0; fi
  for picked in "${only_list[@]}"; do
    [[ "$picked" == "$name" ]] && return 0
  done
  return 1
}

rewrite_paths_for_platform() {
  local platform="$1"
  local md="$2"
  [[ -f "$md" ]] || return 0
  if [[ "$platform" == "codex" ]]; then
    sed -i.bak \
      -e "s#~/.claude/skills#~/.codex/skills#g" \
      -e "s#~/.claude/agents#~/.codex/agents#g" \
      -e "s#\\.claude/skills#\\.codex/skills#g" \
      -e "s#\\.claude/agents#\\.codex/agents#g" \
      "$md"
    rm -f "$md.bak"
  elif [[ "$platform" == "opencode" ]]; then
    sed -i.bak \
      -e "s#~/.claude/skills#~/.opencode/skills#g" \
      -e "s#~/.claude/agents#~/.opencode/agents#g" \
      -e "s#\\.claude/skills#\\.opencode/skills#g" \
      -e "s#\\.claude/agents#\\.opencode/agents#g" \
      "$md"
    rm -f "$md.bak"
  elif [[ "$platform" == "cursor" ]]; then
    sed -i.bak \
      -e "s#~/.claude/skills#~/.cursor/skills#g" \
      -e "s#~/.claude/agents#~/.cursor/agents#g" \
      -e "s#\\.claude/skills#\\.cursor/skills#g" \
      -e "s#\\.claude/agents#\\.cursor/agents#g" \
      "$md"
    rm -f "$md.bak"
  fi
}

strip_agent_model_for_platform() {
  local platform="$1"
  local md="$2"
  [[ -f "$md" ]] || return 0

  case "$platform" in
    claude)
      return 0
      ;;
    codex|opencode|cursor)
      local tmp
      tmp="$(mktemp "${TMPDIR:-/tmp}/raptor-agent.XXXXXX")"
      awk '
        BEGIN { fence = 0 }
        /^---[[:space:]]*$/ { fence++; print; next }
        fence == 1 && /^model:[[:space:]]*/ { next }
        { print }
      ' "$md" > "$tmp"
      mv "$tmp" "$md"
      ;;
  esac
}

install_target() {
  local platform="$1"
  local root="$2"
  local skills_target="$root/skills"
  local agents_target="$root/agents"
  local manifest_file="$root/.raptor-install.tsv"
  local installed_skill_dirs=()
  local manifest_lines=()
  local count=0
  local fresh=0
  local replaced=0

  if (( dry_run )); then
    step "Planning ${platform} skills → ${BOLD}${skills_target}${RESET}"
  else
    step "Installing ${platform} skills → ${BOLD}${skills_target}${RESET}"
    mkdir -p "$skills_target"
  fi
  hr

  for name in "${skills[@]}"; do
    should_install "$name" || continue
    local skill_index=-1
    for i in "${!skills[@]}"; do
      if [[ "${skills[i]}" == "$name" ]]; then
        skill_index="$i"
        break
      fi
    done
    if [[ $skill_index -ge 0 && ",${skill_targets[skill_index]}," != *",${platform},"* ]]; then
      continue
    fi
    local src="$SOURCE_DIR/$name"
    local installed_name="${prefix}${name}"
    local dest="$skills_target/$installed_name"
    local category=""
    for i in "${!skills[@]}"; do
      if [[ "${skills[i]}" == "$name" ]]; then
        category="${skill_categories[i]}"
        break
      fi
    done
    local existed=0
    [[ -e "$dest" ]] && existed=1

    local display="$installed_name"
    if [[ -n "$prefix" ]]; then
      display="${name} ${DIM}→${RESET} ${BOLD}${installed_name}${RESET}"
    fi

    if (( dry_run )); then
      if (( existed )); then
        printf '   %s↻%s %s %s(would replace)%s\n' "${YELLOW}" "${RESET}" "$display" "${DIM}" "${RESET}"
      else
        printf '   %s+%s %s %s(would install)%s\n' "${GREEN}" "${RESET}" "$display" "${DIM}" "${RESET}"
      fi
    else
      rm -rf "$dest"
      cp -R "$src" "$dest"
      if [[ -f "$dest/SKILL.md" ]]; then
        if [[ -n "$prefix" ]]; then
          sed -i.bak -E "s/^name:[[:space:]]*${name}[[:space:]]*$/name: ${installed_name}/" "$dest/SKILL.md"
          rm -f "$dest/SKILL.md.bak"
        fi
        rewrite_paths_for_platform "$platform" "$dest/SKILL.md"
      fi
      installed_skill_dirs+=("$dest")
      manifest_lines+=("skill\t${name}\t${category}\t${platform}\t${prefix}\t${src}\t${dest}")
      if (( existed )); then
        printf '   %s↻%s %s %s(replaced)%s\n' "${YELLOW}" "${RESET}" "$display" "${DIM}" "${RESET}"
        replaced=$((replaced + 1))
      else
        printf '   %s✓%s %s\n' "${GREEN}" "${RESET}" "$display"
        fresh=$((fresh + 1))
      fi
    fi
    count=$((count + 1))
  done

  hr

  if [[ ${#only_list[@]} -gt 0 && $count -eq 0 ]]; then
    fail "no skills matched filter: ${only_list[*]}"
    exit 1
  fi

  local selected_agent_names=()
  local selected_agent_categories=()
  local selected_agent_targets=()
  for i in "${!agent_names[@]}"; do
    if [[ "$profile" == "all" || "${agent_default_flags[i]}" == "true" ]]; then
      selected_agent_names+=("${agent_names[i]}")
      selected_agent_categories+=("${agent_categories[i]}")
      selected_agent_targets+=("${agent_targets[i]}")
    fi
  done

  if (( ${#selected_agent_names[@]} > 0 )); then
    if (( dry_run )); then
      step "Planning ${platform} agents → ${BOLD}${agents_target}${RESET}"
    else
      step "Installing ${platform} agents → ${BOLD}${agents_target}${RESET}"
      mkdir -p "$agents_target"
    fi
    hr
    for i in "${!selected_agent_names[@]}"; do
      local agent_name="${selected_agent_names[i]}"
      local category="${selected_agent_categories[i]}"
      if [[ ",${selected_agent_targets[i]}," != *",${platform},"* ]]; then
        continue
      fi
      local src="$AGENTS_SRC/${agent_name}.md"
      local installed="${prefix}${agent_name}"
      local dest="$agents_target/${installed}.md"
      local existed=0
      [[ -e "$dest" ]] && existed=1

      if (( dry_run )); then
        if (( existed )); then
          printf '   %s↻%s %s.md %s(would replace)%s\n' "${YELLOW}" "${RESET}" "$installed" "${DIM}" "${RESET}"
        else
          printf '   %s+%s %s.md %s(would install)%s\n' "${GREEN}" "${RESET}" "$installed" "${DIM}" "${RESET}"
        fi
      else
        cp "$src" "$dest"
        if [[ -n "$prefix" ]]; then
          sed -i.bak -E "s/^name:[[:space:]]*${agent_name}[[:space:]]*$/name: ${installed}/" "$dest"
          rm -f "$dest.bak"
        fi
        rewrite_paths_for_platform "$platform" "$dest"
        strip_agent_model_for_platform "$platform" "$dest"
        manifest_lines+=("agent\t${agent_name}\t${category}\t${platform}\t${prefix}\t${src}\t${dest}")
        if (( existed )); then
          printf '   %s↻%s %s.md %s(replaced)%s\n' "${YELLOW}" "${RESET}" "$installed" "${DIM}" "${RESET}"
        else
          printf '   %s✓%s %s.md\n' "${GREEN}" "${RESET}" "$installed"
        fi
      fi
    done
    hr

    if [[ -n "$prefix" && ${#installed_skill_dirs[@]} -gt 0 && $dry_run -eq 0 ]]; then
      sed_args=()
      for agent_name in "${agent_names[@]}"; do
        sed_args+=(-e "s/([^a-zA-Z0-9_-])${agent_name}([^a-zA-Z0-9_-])/\1${prefix}${agent_name}\2/g")
      done
      for md_dir in "${installed_skill_dirs[@]}"; do
        md="$md_dir/SKILL.md"
        [[ -f "$md" ]] || continue
        sed -i.bak -E "${sed_args[@]}" "$md"
        rm -f "$md.bak"
      done
    fi
  fi

  if (( dry_run == 0 )); then
    {
      printf 'kind\tid\tcategory\ttarget\tprefix\tsource\tdest\n'
      for line in "${manifest_lines[@]}"; do
        printf '%b\n' "$line"
      done
    } > "$manifest_file"
  fi

  TARGET_COUNTS+=("${platform}:${count}:${fresh}:${replaced}")
}

TARGET_COUNTS=()
install_target "claude" "$CLAUDE_ROOT"
printf '\n'
install_target "codex" "$CODEX_ROOT"
printf '\n'
install_target "opencode" "$OPENCODE_ROOT"
printf '\n'
install_target "cursor" "$CURSOR_ROOT"

statusline_installed=0
statusline_settings_note=""

install_statusline() {
  local dest="$CLAUDE_ROOT/raptor-statusline.sh"
  local settings="$CLAUDE_ROOT/settings.json"
  local cmd="bash \"$dest\""
  local ts
  ts="$(date +%s)-$$"

  if [[ ! -f "$STATUSLINE_SRC" ]]; then
    warn "statusline source missing at $STATUSLINE_SRC — skipping"
    return 1
  fi

  if (( dry_run )); then
    if [[ -f "$dest" ]]; then
      printf '   %s↻%s raptor-statusline.sh %s(would replace)%s\n' "${YELLOW}" "${RESET}" "${DIM}" "${RESET}"
    else
      printf '   %s+%s raptor-statusline.sh %s(would install)%s\n' "${GREEN}" "${RESET}" "${DIM}" "${RESET}"
    fi
    if [[ -f "$settings" ]]; then
      printf '   %s↻%s settings.json statusLine %s(would update)%s\n' "${YELLOW}" "${RESET}" "${DIM}" "${RESET}"
    else
      printf '   %s+%s settings.json %s(would create)%s\n' "${GREEN}" "${RESET}" "${DIM}" "${RESET}"
    fi
    statusline_installed=1
    return 0
  fi

  if [[ -f "$dest" ]] && ! cmp -s "$STATUSLINE_SRC" "$dest"; then
    cp "$dest" "${dest}.bak.${ts}"
  fi
  cp "$STATUSLINE_SRC" "$dest"
  chmod +x "$dest"
  printf '   %s✓%s raptor-statusline.sh %s→ %s%s\n' "${GREEN}" "${RESET}" "${DIM}" "$dest" "${RESET}"

  if command -v jq >/dev/null 2>&1; then
    local tmp
    tmp="$(mktemp -- "$CLAUDE_ROOT/.settings.XXXXXX")"
    if [[ -f "$settings" ]]; then
      if ! jq --arg cmd "$cmd" \
        '.statusLine = (.statusLine // {}) + {type:"command", command:$cmd}' \
        "$settings" >"$tmp" 2>/dev/null; then
        rm -f "$tmp"
        warn "could not parse $settings — leaving it untouched"
        statusline_settings_note="manual: add { \"statusLine\": { \"type\":\"command\", \"command\":\"$cmd\" } }"
        statusline_installed=1
        return 0
      fi
      cp "$settings" "${settings}.bak.${ts}"
      mv "$tmp" "$settings"
      printf '   %s✓%s settings.json statusLine %s(prev backed up)%s\n' "${GREEN}" "${RESET}" "${DIM}" "${RESET}"
    else
      jq -n --arg cmd "$cmd" '{statusLine:{type:"command", command:$cmd}}' >"$settings"
      rm -f "$tmp"
      printf '   %s✓%s settings.json %s(created)%s\n' "${GREEN}" "${RESET}" "${DIM}" "${RESET}"
    fi
  else
    local cmd_json="${cmd//\"/\\\"}"
    if [[ -f "$settings" ]]; then
      warn "jq not found — settings.json left untouched"
      statusline_settings_note="manual: add { \"statusLine\": { \"type\":\"command\", \"command\":\"${cmd_json}\" } }"
    else
      cat >"$settings" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "${cmd_json}"
  }
}
EOF
      printf '   %s✓%s settings.json %s(created)%s\n' "${GREEN}" "${RESET}" "${DIM}" "${RESET}"
    fi
  fi

  statusline_installed=1
}

if [[ "$statusline_choice" == "yes" ]]; then
  printf '\n'
  if (( dry_run )); then
    step "Planning statusline install"
  else
    step "Installing statusline"
  fi
  hr
  install_statusline || true
  hr
fi

printf '\n'
summary_lines=()
if (( dry_run )); then
  summary_lines+=("${BOLD}Dry-run complete${RESET}")
else
  summary_lines+=("${GREEN}✓${RESET} ${BOLD}Raptor installed${RESET}")
fi

for target_info in "${TARGET_COUNTS[@]}"; do
  IFS=':' read -r platform count fresh replaced <<<"$target_info"
  if (( dry_run )); then
    summary_lines+=("${BOLD}${platform}${RESET}  ${DIM}${count} skill(s) would be installed${RESET}")
  else
    summary_lines+=("${BOLD}${platform}${RESET}  ${DIM}${count} skill(s) installed (${fresh} new · ${replaced} replaced)${RESET}")
  fi
done

summary_lines+=(
  ""
  "${BOLD}Claude${RESET}    ${DIM}${CLAUDE_ROOT}/skills/${prefix}<name>${RESET}"
  "${BOLD}Codex${RESET}   ${DIM}${CODEX_ROOT}/skills/${prefix}<name>${RESET}"
  "${BOLD}opencode${RESET}  ${DIM}${OPENCODE_ROOT}/skills/${prefix}<name>${RESET}"
  "${BOLD}Cursor${RESET}  ${DIM}${CURSOR_ROOT}/skills/${prefix}<name>${RESET}"
  "${BOLD}Docs${RESET}    ${DIM}https://github.com/${REPO}${RESET}"
)

if (( statusline_installed )); then
  summary_lines+=("" "${BOLD}Statusline${RESET}  ${DIM}${CLAUDE_ROOT}/raptor-statusline.sh${RESET}")
fi

boxed "${summary_lines[@]}"
if [[ -n "$statusline_settings_note" ]]; then
  printf '\n'
  warn "$statusline_settings_note"
fi
printf '\n'
