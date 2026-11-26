#!/usr/bin/env bash

# Shared semantic renderer for the installer command centre. Callers pass only
# fixed vocabulary values; invalid values are rendered as "unknown" rather
# than copied into operator-visible output.
#
# Needs bash 4.1+: {fd}<> redirections, local -A, fractional read -t and
# read -N all arrive by 4.1.

installer_ui_mode="plain"
installer_ui_started_at=0
installer_ui_simulation=0
# Set by install.sh just before the terminal `failed` event that follows a
# `recovery-command:` line; appended as a trailing field in plain mode only.
installer_ui_recovery=""

installer_ui_init() {
  local requested_mode="" requested_simulation=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plain)
        requested_mode="plain"
        ;;
      --tty)
        requested_mode="tty"
        ;;
      --simulation)
        requested_simulation=1
        ;;
      *)
        return 2
        ;;
    esac
    shift
  done

  if [[ "${ORBIT_INSTALLER_PLAIN:-0}" == 1 ]]; then
    requested_mode="plain"
  fi

  if [[ "$requested_mode" == tty ]] && {
    [[ ! -t 1 ]] || [[ -v NO_COLOR ]] || [[ "${TERM:-}" == dumb ]]
  }; then
    requested_mode="plain"
  fi
  if [[ -z "$requested_mode" ]]; then
    if [[ -t 1 && ! -v NO_COLOR && "${TERM:-}" != dumb ]]; then
      requested_mode="tty"
    else
      requested_mode="plain"
    fi
  fi

  installer_ui_mode="$requested_mode"
  installer_ui_started_at="$SECONDS"
  installer_ui_simulation="$requested_simulation"
}

# Save and restore only the trapped-signal state a caller actually had, so a
# widget's temporary INT/TERM/HUP handling never silently replaces a caller's
# own trap with the default disposition.
installer_ui_save_traps() {
  installer_ui_saved_trap_int="$(trap -p INT)"
  installer_ui_saved_trap_term="$(trap -p TERM)"
  installer_ui_saved_trap_hup="$(trap -p HUP)"
}

installer_ui_restore_traps() {
  if [[ -n "$installer_ui_saved_trap_int" ]]; then
    eval "$installer_ui_saved_trap_int"
  else
    trap - INT
  fi
  if [[ -n "$installer_ui_saved_trap_term" ]]; then
    eval "$installer_ui_saved_trap_term"
  else
    trap - TERM
  fi
  if [[ -n "$installer_ui_saved_trap_hup" ]]; then
    eval "$installer_ui_saved_trap_hup"
  else
    trap - HUP
  fi
}

installer_ui_resume_clock() {
  [[ "$1" =~ ^[0-9]{1,9}$ ]] || return 2
  installer_ui_started_at="$1"
}

installer_ui_safe_field() {
  local field="$1"
  local value="$2"

  case "$field:$value" in
    phase:bootstrap|phase:host|phase:identity|phase:assets|phase:configuration|phase:oidc|phase:compose|phase:preparation|phase:database|phase:application|phase:optional|phase:complete|phase:rollback)
      printf '%s' "$value"
      ;;
    component:installer|component:host|component:image|component:assets|component:configuration|component:oidc|component:compose|component:database|component:application|component:clamav|component:tika|component:ollama)
      printf '%s' "$value"
      ;;
    state:waiting|state:starting|state:running|state:healthy|state:skipped|state:completed|state:blocked|state:failed)
      printf '%s' "$value"
      ;;
    reason:initial|reason:target|reason:channel|reason:digest|reason:source-revision|reason:semantic-version|reason:revision|reason:configuration|reason:configuration-required|reason:discovery|reason:compose-config|reason:database-image|reason:service-start|reason:status-verified|reason:installed|reason:host-tools|reason:image-identity|reason:assets-verified|reason:configuration-migration|reason:provider-discovery|reason:compose-validation|reason:service-preparation|reason:database-health|reason:application-health|reason:optional-status|reason:deployment-ready|reason:docker-host|reason:image-registry|reason:configuration-failure|reason:provider-unavailable|reason:database-auth-migration|reason:application-startup|reason:health-timeout|reason:optional-unavailable|reason:failure|reason:rollback|reason:repair-unavailable|reason:update-path|reason:update-readiness|reason:folder-moved|reason:unknown)
      printf '%s' "$value"
      ;;
    action:begin|action:validate|action:pull|action:inspect|action:fetch|action:configure|action:verify|action:check|action:start|action:wait|action:health|action:skip|action:status|action:complete|action:retry|action:rollback|action:repair|action:continue|action:display|action:abort)
      printf '%s' "$value"
      ;;
    recovery:command)
      printf '%s' "$value"
      ;;
    *)
      printf 'unknown'
      ;;
  esac
}

installer_ui_elapsed() {
  local elapsed="$1"

  if [[ ! "$elapsed" =~ ^[0-9]{1,9}$ ]]; then
    printf '0s'
  else
    printf '%ss' "$elapsed"
  fi
}

installer_ui_emit() {
  [[ $# -eq 5 || $# -eq 6 ]] || return 2

  local phase component state reason action elapsed recovery=""
  phase="$(installer_ui_safe_field phase "$1")"
  component="$(installer_ui_safe_field component "$2")"
  state="$(installer_ui_safe_field state "$3")"
  reason="$(installer_ui_safe_field reason "$4")"
  action="$(installer_ui_safe_field action "$5")"
  if [[ $# -eq 6 ]]; then
    elapsed="$(installer_ui_elapsed "$6")"
  else
    elapsed="$(installer_ui_elapsed "$((SECONDS - installer_ui_started_at))")"
  fi
  [[ -z "$installer_ui_recovery" ]] ||
    recovery=" recovery=$(installer_ui_safe_field recovery "$installer_ui_recovery")"

  if [[ "$installer_ui_mode" == tty ]]; then
    local state_color='\033[33m' width simulation_prefix=""
    [[ "$installer_ui_simulation" != 1 ]] || simulation_prefix='[SIMULATION] '
    case "$state" in
      waiting|starting|running) state_color='\033[36m' ;;
      healthy|completed) state_color='\033[32m' ;;
      skipped) state_color='\033[33m' ;;
      blocked|failed) state_color='\033[31m' ;;
    esac
    width="$(installer_ui_terminal_width 1)"
    if ((width < 60)); then
      printf '%s[%s] %s %b%s\033[0m %s\n' \
        "$simulation_prefix" "$elapsed" "$component" "$state_color" "$state" "$reason"
    else
      printf '%s[%s] %-13s %-12s %b%-9s\033[0m %s / %s\n' \
        "$simulation_prefix" "$elapsed" "$phase" "$component" "$state_color" "$state" "$reason" "$action"
    fi
  elif [[ "$installer_ui_simulation" == 1 ]]; then
    printf 'phase=%s component=%s state=%s reason=%s action=%s elapsed=%s simulation=true%s\n' \
      "$phase" "$component" "$state" "$reason" "$action" "$elapsed" "$recovery"
  else
    printf 'phase=%s component=%s state=%s reason=%s action=%s elapsed=%s%s\n' \
      "$phase" "$component" "$state" "$reason" "$action" "$elapsed" "$recovery"
  fi
}

# Reads one byte from fd $1 with timeout $2 into the caller-named variable $3.
# Every timed read in this file goes through here (#1967): when read -t's timer
# fires just as a byte lands, bash returns a status above 128 *and* keeps the
# byte in the variable (the manual: "read saves any partial input"). Treating
# every such status as "nothing arrived" dropped that key, which in the prune
# prompt could turn " yes" or "yeas" into the exact "yes". So the variable is
# checked before the status is trusted. -N 1 takes the byte whatever it is, so
# Enter arrives as $'\n' or $'\r', not as an empty string.
# Returns:
#   0     a byte (status 0, or above 128 with the variable set). The value can
#         be empty only on a bash that hands back a NUL byte (5.2 skips NULs
#         inside read); callers treat an empty byte as no key at all.
#   >128  a tick: the timer (or a trapped signal) fired with nothing read. The
#         read's own status is passed through, normally 142.
#   other EOF or a read error, status passed through.
# Writes with printf -v, not command substitution; see installer_ui_read_key.
installer_ui_read_byte() {
  local __installer_ui_fd="$1" __installer_ui_timeout="$2" __installer_ui_outvar="$3"
  local __installer_ui_byte="" __installer_ui_status=0
  IFS= read -r -s -N 1 -t "$__installer_ui_timeout" -u "$__installer_ui_fd" __installer_ui_byte ||
    __installer_ui_status=$?
  if ((__installer_ui_status == 0)) ||
    { ((__installer_ui_status > 128)) && [[ -n "$__installer_ui_byte" ]]; }; then
    printf -v "$__installer_ui_outvar" '%s' "$__installer_ui_byte"
    return 0
  fi
  printf -v "$__installer_ui_outvar" '%s' ''
  return "$__installer_ui_status"
}

# Writes the decoded key name into the caller-named variable $2 rather than
# printing it for command substitution. A command substitution would fork a
# subshell per keystroke; a signal delivered to the calling process while that
# child is blocked in its own read would not interrupt it, so a caller's trap
# could not respond until the forked read happened to finish on its own. A
# direct call keeps every blocking read in the signalled process itself.
installer_ui_read_key() {
  local terminal_fd="$1" outvar="$2" raw_key next read_status=0

  installer_ui_read_byte "$terminal_fd" 0.2 raw_key || read_status=$?
  if [[ "$read_status" != 0 ]]; then
    if ((read_status > 128)); then
      printf -v "$outvar" '%s' 'timeout'
      return 0
    fi
    return "$read_status"
  fi
  # -N 1 delivers Enter as LF or CR (#1967); an empty byte is a NUL from a
  # bash that passes NULs through, and must not become a key that edits or
  # submits an answer.
  case "$raw_key" in
    $'\n'|$'\r') printf -v "$outvar" '%s' 'enter'; return 0 ;;
    '') printf -v "$outvar" '%s' 'ignore'; return 0 ;;
  esac
  if [[ "$raw_key" != $'\033' ]]; then
    case "$raw_key" in
      $'\004') return 1 ;;
      $'\177'|$'\b') printf -v "$outvar" '%s' 'backspace' ;;
      [[:print:]]) printf -v "$outvar" 'char:%s' "$raw_key" ;;
      *) printf -v "$outvar" '%s' 'ignore' ;;
    esac
    return 0
  fi

  if ! installer_ui_read_byte "$terminal_fd" 0.08 next; then
    printf -v "$outvar" '%s' 'escape'
    return 0
  fi
  if [[ "$next" == "]" ]]; then
    # OSC strings are presentation-only. Consume them through BEL or the
    # two-byte ST terminator so a title/icon sequence cannot leak into a
    # value as ordinary text.
    local osc_byte="" osc_index
    for ((osc_index = 0; osc_index < 256; osc_index++)); do
      if ! installer_ui_read_byte "$terminal_fd" 0.08 osc_byte; then
        printf -v "$outvar" '%s' 'ignore'
        return 0
      fi
      case "$osc_byte" in
        $'\a') printf -v "$outvar" '%s' 'ignore'; return 0 ;;
        $'\033')
          if installer_ui_read_byte "$terminal_fd" 0.08 osc_byte &&
            [[ "$osc_byte" == "\\" ]]; then
            printf -v "$outvar" '%s' 'ignore'
          else
            printf -v "$outvar" '%s' 'ignore'
          fi
          return 0
          ;;
      esac
    done
    printf -v "$outvar" '%s' 'ignore'
    return 0
  fi

  if [[ "$next" == "[" || "$next" == "O" ]]; then
    # CSI/SS3 sequences end at an ASCII final byte. Reading to that boundary
    # keeps unsupported parameters (for example ESC [ 1 ; 2 A) from being
    # reinterpreted as user text. The bound prevents a malformed sequence
    # from monopolising an input widget indefinitely.
    local prefix="$next" sequence="" final="" sequence_byte="" sequence_index
    for ((sequence_index = 0; sequence_index < 32; sequence_index++)); do
      if ! installer_ui_read_byte "$terminal_fd" 0.08 sequence_byte; then
        printf -v "$outvar" '%s' 'ignore'
        return 0
      fi
      if [[ "$sequence_byte" == [@-~] ]]; then
        final="$sequence_byte"
        break
      fi
      [[ "$sequence_byte" != $'\033' ]] || {
        printf -v "$outvar" '%s' 'ignore'
        return 0
      }
      sequence+="$sequence_byte"
    done
    [[ -n "$final" ]] || {
      printf -v "$outvar" '%s' 'ignore'
      return 0
    }

    if [[ "$prefix" == "O" && -z "$sequence" ]]; then
      case "$final" in
        A) printf -v "$outvar" '%s' 'up'; return 0 ;;
        B) printf -v "$outvar" '%s' 'down'; return 0 ;;
        C) printf -v "$outvar" '%s' 'right'; return 0 ;;
        D) printf -v "$outvar" '%s' 'left'; return 0 ;;
        H) printf -v "$outvar" '%s' 'home'; return 0 ;;
        F) printf -v "$outvar" '%s' 'end'; return 0 ;;
      esac
    fi

    case "$sequence$final" in
      A) printf -v "$outvar" '%s' 'up' ;;
      B) printf -v "$outvar" '%s' 'down' ;;
      C) printf -v "$outvar" '%s' 'right' ;;
      D) printf -v "$outvar" '%s' 'left' ;;
      H) printf -v "$outvar" '%s' 'home' ;;
      F) printf -v "$outvar" '%s' 'end' ;;
      1~|7~) printf -v "$outvar" '%s' 'home' ;;
      3~) printf -v "$outvar" '%s' 'delete' ;;
      4~|8~) printf -v "$outvar" '%s' 'end' ;;
      200~) printf -v "$outvar" '%s' 'paste-start' ;;
      201~) printf -v "$outvar" '%s' 'paste-end' ;;
      *) printf -v "$outvar" '%s' 'ignore' ;;
    esac
    return 0
  fi

  printf -v "$outvar" '%s' 'ignore'
  return 0
}

# Writes the pasted payload into the caller-named variable $3; see
# installer_ui_read_key for why this avoids a per-read command substitution.
# Reads "${interrupted:-0}" from the caller's frame by design: a direct call
# (not a subshell) makes the caller's INT/TERM/HUP trap update that same
# variable while this loop is still blocked in a read.
installer_ui_read_paste() {
  local terminal_fd="$1" maximum="$2" outvar="$3" byte payload="" marker=$'\033[201~' read_status=0 idle_timeouts=0
  while true; do
    read_status=0
    installer_ui_read_byte "$terminal_fd" 0.2 byte || read_status=$?
    if [[ "$read_status" != 0 ]]; then
      if ((read_status > 128)); then
        [[ "${interrupted:-0}" == 0 ]] || return 130
        idle_timeouts=$((idle_timeouts + 1))
        ((idle_timeouts < 5)) || return 1
        continue
      fi
      return "$read_status"
    fi
    idle_timeouts=0
    [[ "$byte" != $'\004' ]] || return 1
    # With -N 1 a line break arrives as LF or CR, never empty (#1967); both
    # become LF, which the control-character check below rejects. An empty
    # byte (a passed-through NUL) adds nothing.
    case "$byte" in
      $'\n'|$'\r') byte=$'\n' ;;
      '') continue ;;
    esac
    payload+="$byte"
    if [[ "$payload" == *"$marker" ]]; then
      payload="${payload%"$marker"}"
      break
    fi
    ((${#payload} <= maximum + ${#marker})) || return 2
  done
  ((${#payload} <= maximum)) || return 2
  [[ "$payload" != *$'\033'* && ! "$payload" =~ [[:cntrl:]] ]] || return 2
  printf -v "$outvar" '%s' "$payload"
}

installer_ui_terminal_width() {
  local terminal_fd="$1" size="" width=""
  size="$(stty size <&"$terminal_fd" 2>/dev/null || true)"
  width="${size##* }"
  if [[ ! "$width" =~ ^[0-9]+$ || "$width" == 0 ]]; then
    width="${COLUMNS:-80}"
  fi
  [[ "$width" =~ ^[0-9]+$ ]] || width=80
  ((width < 20)) && width=20
  ((width > 240)) && width=240
  printf '%s' "$width"
}

installer_ui_fit_menu_label() {
  local terminal_fd="$1" label="$2" width available
  width="$(installer_ui_terminal_width "$terminal_fd")"
  available=$((width - 7))
  if ((${#label} > available)); then
    printf '%s...' "${label:0:available-3}"
  else
    printf '%s' "$label"
  fi
}

# Renders labels the caller has already fitted. No command substitution runs
# here, so the render is safe inside a trap-armed window: a trapped signal
# delivered while bash is inside a $( ) corrupts the trap's own re-parse
# ("trap: line 2: unexpected EOF") and aborts the surrounding context (#625).
installer_ui_menu_render() {
  local terminal_fd="$1" selected="$2"
  shift 2
  local index=0 marker label
  for label in "$@"; do
    marker=" "
    [[ "$index" == "$selected" ]] && marker=">"
    printf '%s %d) %s\n' "$marker" "$((index + 1))" "$label" >&"$terminal_fd"
    index=$((index + 1))
  done
}

# Print the selected fixed identifier to stdout. Menu frames go only to the
# controlling terminal descriptor so command substitution never captures
# presentation bytes as configuration.
installer_ui_select() {
  [[ $# -ge 5 && $((($# - 3) % 2)) -eq 0 ]] || return 2
  local terminal_fd="$1" prompt="$2" default_id="$3"
  shift 3
  local -a items=("$@")
  local count selected=0 index key
  count=$((${#items[@]} / 2))

  for ((index = 0; index < count; index++)); do
    [[ "${items[index * 2]}" == "$default_id" ]] && selected="$index"
  done

  # Every label is fitted here, before any trap is armed, and the results are
  # reused by the initial render and every redraw. Fitting forks a command
  # substitution per label, and a trapped signal landing while bash is inside
  # one corrupts the parse and aborts this whole context past the stty
  # restore, leaving the terminal raw — reproduced at will on bash 5.2.21 and
  # 5.2.37 (#625). The trade: a terminal resized mid-menu keeps the widths
  # the menu opened with.
  local -a fitted=()
  for ((index = 0; index < count; index++)); do
    fitted+=("$(installer_ui_fit_menu_label "$terminal_fd" "${items[index * 2 + 1]}")")
  done

  printf '%s\n\n' "$prompt" >&"$terminal_fd"
  if [[ -t "$terminal_fd" && "${TERM:-}" != dumb ]]; then
    # Single-key navigation, including a lone Escape, is only delivered
    # portably in noncanonical mode: canonical mode buffers input until a
    # line terminator, so a bare Escape would otherwise sit unread until
    # Enter (or EOF) arrived. Save and restore the caller's exact prior mode
    # and any prior INT/TERM/HUP trap across every exit path.
    local saved_state interrupted=0 status=0 restore_status=0 chosen=0
    saved_state="$(stty -g <&"$terminal_fd" 2>/dev/null)" || return 1
    # The trap goes up before the terminal leaves canonical mode: in the old
    # order a signal landing between stty and trap still had its default
    # disposition and killed the shell with the terminal unrestored.
    installer_ui_save_traps
    trap 'interrupted=1' INT TERM HUP
    stty -echo -icanon min 1 time 0 <&"$terminal_fd" 2>/dev/null || {
      stty "$saved_state" <&"$terminal_fd" 2>/dev/null
      installer_ui_restore_traps
      return 1
    }

    installer_ui_menu_render "$terminal_fd" "$selected" "${fitted[@]}"
    while true; do
      installer_ui_read_key "$terminal_fd" key || {
        status=1
        break
      }
      case "$key" in
        timeout)
          if [[ "$interrupted" == 1 ]]; then
            status=130
            break
          fi
          continue
          ;;
        up) selected=$(((selected + count - 1) % count)) ;;
        down) selected=$(((selected + 1) % count)) ;;
        enter)
          chosen=1
          break
          ;;
        escape)
          status=130
          break
          ;;
        char:[1-9])
          index="${key#char:}"
          if ((index >= 1 && index <= count)); then
            selected=$((index - 1))
            chosen=1
            break
          fi
          ;;
        *) continue ;;
      esac
      printf '\033[%dA' "$count" >&"$terminal_fd"
      for ((index = 0; index < count; index++)); do
        printf '\r\033[2K' >&"$terminal_fd"
        if [[ "$index" == "$selected" ]]; then
          printf '> %d) %s\n' "$((index + 1))" "${fitted[index]}" >&"$terminal_fd"
        else
          printf '  %d) %s\n' "$((index + 1))" "${fitted[index]}" >&"$terminal_fd"
        fi
      done
    done

    stty "$saved_state" <&"$terminal_fd" 2>/dev/null || restore_status=1
    installer_ui_restore_traps
    [[ "$restore_status" == 0 ]] || return 1
    [[ "$interrupted" == 0 ]] || return 130
    [[ "$status" == 0 ]] || return "$status"
    if [[ "$chosen" == 1 ]]; then
      printf '%s' "${items[selected * 2]}"
      return 0
    fi
    return 1
  fi

  installer_ui_menu_render "$terminal_fd" "$selected" "${fitted[@]}"
  while true; do
    printf 'Choice [%d]: ' "$((selected + 1))" >&"$terminal_fd"
    IFS= read -r -u "$terminal_fd" key || return 1
    [[ "$key" == $'\033' ]] && return 130
    [[ -z "$key" ]] && key="$((selected + 1))"
    [[ "$key" =~ ^[1-9][0-9]*$ ]] || continue
    index="$key"
    if ((index <= count)); then
      printf '%s' "${items[(index - 1) * 2]}"
      return 0
    fi
  done
}

# Display width of $1 in terminal columns, set in installer_ui_width_result (no
# subshell). wcwidth-style lookup (Markus Kuhn's wcwidth.c): characters whose
# Unicode East Asian Width is W or F (ranges below, Unicode 15.1, lo hi pairs)
# take two columns, everything else one. Combining and zero-width characters
# are not handled.
installer_ui_wide_ranges=(
  0x1100 0x115F 0x231A 0x231B 0x2329 0x232A 0x23E9 0x23EC 0x23F0 0x23F0
  0x23F3 0x23F3 0x25FD 0x25FE 0x2614 0x2615 0x2648 0x2653 0x267F 0x267F
  0x2693 0x2693 0x26A1 0x26A1 0x26AA 0x26AB 0x26BD 0x26BE 0x26C4 0x26C5
  0x26CE 0x26CE 0x26D4 0x26D4 0x26EA 0x26EA 0x26F2 0x26F3 0x26F5 0x26F5
  0x26FA 0x26FA 0x26FD 0x26FD 0x2705 0x2705 0x270A 0x270B 0x2728 0x2728
  0x274C 0x274C 0x274E 0x274E 0x2753 0x2755 0x2757 0x2757 0x2795 0x2797
  0x27B0 0x27B0 0x27BF 0x27BF 0x2B1B 0x2B1C 0x2B50 0x2B50 0x2B55 0x2B55
  0x2E80 0x2E99 0x2E9B 0x2EF3 0x2F00 0x2FD5 0x2FF0 0x303E 0x3041 0x3096
  0x3099 0x30FF 0x3105 0x312F 0x3131 0x318E 0x3190 0x31E3 0x31EF 0x321E
  0x3220 0x3247 0x3250 0x4DBF 0x4E00 0xA48C 0xA490 0xA4C6 0xA960 0xA97C
  0xAC00 0xD7A3 0xF900 0xFAFF 0xFE10 0xFE19 0xFE30 0xFE52 0xFE54 0xFE66
  0xFE68 0xFE6B 0xFF01 0xFF60 0xFFE0 0xFFE6 0x16FE0 0x16FE4 0x16FF0 0x16FF1
  0x17000 0x187F7 0x18800 0x18CD5 0x18D00 0x18D08 0x1AFF0 0x1AFF3
  0x1AFF5 0x1AFFB 0x1AFFD 0x1AFFE 0x1B000 0x1B122 0x1B132 0x1B132
  0x1B150 0x1B152 0x1B155 0x1B155 0x1B164 0x1B167 0x1B170 0x1B2FB
  0x1F004 0x1F004 0x1F0CF 0x1F0CF 0x1F18E 0x1F18E 0x1F191 0x1F19A
  0x1F200 0x1F202 0x1F210 0x1F23B 0x1F240 0x1F248 0x1F250 0x1F251
  0x1F260 0x1F265 0x1F300 0x1F320 0x1F32D 0x1F335 0x1F337 0x1F37C
  0x1F37E 0x1F393 0x1F3A0 0x1F3CA 0x1F3CF 0x1F3D3 0x1F3E0 0x1F3F0
  0x1F3F4 0x1F3F4 0x1F3F8 0x1F43E 0x1F440 0x1F440 0x1F442 0x1F4FC
  0x1F4FF 0x1F53D 0x1F54B 0x1F54E 0x1F550 0x1F567 0x1F57A 0x1F57A
  0x1F595 0x1F596 0x1F5A4 0x1F5A4 0x1F5FB 0x1F64F 0x1F680 0x1F6C5
  0x1F6CC 0x1F6CC 0x1F6D0 0x1F6D2 0x1F6D5 0x1F6D7 0x1F6DC 0x1F6DF
  0x1F6EB 0x1F6EC 0x1F6F4 0x1F6FC 0x1F7E0 0x1F7EB 0x1F7F0 0x1F7F0
  0x1F90C 0x1F93A 0x1F93C 0x1F945 0x1F947 0x1F9FF 0x1FA70 0x1FA7C
  0x1FA80 0x1FA88 0x1FA90 0x1FABD 0x1FABF 0x1FAC5 0x1FACE 0x1FADB
  0x1FAE0 0x1FAE8 0x1FAF0 0x1FAF8 0x20000 0x2FFFD 0x30000 0x3FFFD
)
installer_ui_width_result=0
installer_ui_width() {
  local text="$1" c code n=0 i k
  for ((i = 0; i < ${#text}; i++)); do
    c="${text:i:1}"
    printf -v code '%d' "'$c" 2>/dev/null || code=0
    n=$((n + 1))
    ((code >= 0x1100)) || continue
    for ((k = 0; k < ${#installer_ui_wide_ranges[@]}; k += 2)); do
      ((code >= installer_ui_wide_ranges[k])) || break
      if ((code <= installer_ui_wide_ranges[k + 1])); then
        n=$((n + 1))
        break
      fi
    done
  done
  installer_ui_width_result=$n
}

# Cursor echo for a terminal that cannot repaint (TERM=dumb), without escape
# sequences, as readline does: \b to move left, reprint to move right, and an
# edit reprints the tail then backs over it. No-op unless plain_echo is set.
# $4 is the text moved over; \b counts are display columns, not characters.
installer_ui_plain_move() {
  [[ "$2" == 1 ]] || return 0
  if [[ "$3" == back ]]; then
    local n
    installer_ui_width "$4"
    for ((n = 0; n < installer_ui_width_result; n++)); do printf '\b' >&"$1"; done
  else
    printf '%s' "$4" >&"$1"
  fi
}

# $3 text backed over first, $4 inserted text, $5 tail after the cursor, $6 the
# removed character (blanked with as many cells as its display width).
installer_ui_plain_edit() {
  [[ "$2" == 1 ]] || return 0
  local n cells=0 blank=0
  installer_ui_width "$3"
  for ((n = 0; n < installer_ui_width_result; n++)); do printf '\b' >&"$1"; done
  printf '%s' "$4$5" >&"$1"
  if [[ -n "${6:-}" ]]; then
    installer_ui_width "$6"
    blank=$installer_ui_width_result
    for ((n = 0; n < blank; n++)); do printf ' ' >&"$1"; done
  fi
  installer_ui_width "$5"
  cells=$((installer_ui_width_result + blank))
  for ((n = 0; n < cells; n++)); do printf '\b' >&"$1"; done
}

installer_ui_read_value() {
  [[ $# -eq 4 ]] || return 2
  local terminal_fd="$1" prompt="$2" maximum="$3" visibility="$4"
  local value="" saved_state status=0 restore_status=0 interrupted=0 key insert="" cursor=0 tail=0 repaint=1 plain_echo=0
  [[ "$maximum" =~ ^[1-9][0-9]{0,5}$ ]] || return 2
  [[ "$visibility" == text || "$visibility" == secret ]] || return 2
  [[ "${TERM:-}" != dumb && "${ORBIT_INSTALLER_PLAIN:-0}" != 1 ]] || repaint=0
  # Three cases. Repainting terminal: the line is redrawn, arrows move the
  # cursor. Plain mode on a normal TERM (ORBIT_INSTALLER_PLAIN=1/--plain): no
  # echo is repainted, the cursor stays at the end, arrow keys are ignored
  # (#1834). TERM=dumb: visible text is echoed with no escape sequences, arrows
  # and edits move the cursor by \b and reprint (plain_echo).
  [[ "$visibility" != text ]] || ((repaint == 1)) || plain_echo=1
  local arrows=1
  [[ "${ORBIT_INSTALLER_PLAIN:-0}" != 1 || "${TERM:-}" == dumb ]] || arrows=0

  saved_state="$(stty -g <&"$terminal_fd" 2>/dev/null)" || return 1
  # Trap before raw mode, as in installer_ui_select: a signal landing between
  # stty and trap otherwise kills the shell with the terminal unrestored.
  installer_ui_save_traps
  trap 'interrupted=1' INT TERM HUP
  stty -echo -icanon min 1 time 0 <&"$terminal_fd" 2>/dev/null || {
    installer_ui_restore_traps
    return 1
  }
  printf '%s' "$prompt" >&"$terminal_fd"
  while true; do
    installer_ui_read_key "$terminal_fd" key || {
      status=1
      break
    }
    case "$key" in
      timeout)
        if [[ "$interrupted" == 1 ]]; then
          status=130
          break
        fi
        continue
        ;;
      enter) break ;;
      escape)
        status=130
        break
        ;;
      left) ((arrows == 0)) && continue; ((cursor > 0)) && { cursor=$((cursor - 1)); installer_ui_plain_move "$terminal_fd" "$plain_echo" back "${value:cursor:1}"; } ;;
      right) ((arrows == 0)) && continue; ((cursor < ${#value})) && { installer_ui_plain_move "$terminal_fd" "$plain_echo" fwd "${value:cursor:1}"; cursor=$((cursor + 1)); } ;;
      home) ((arrows == 0)) && continue; installer_ui_plain_move "$terminal_fd" "$plain_echo" back "${value:0:cursor}"; cursor=0 ;;
      end) ((arrows == 0)) && continue; installer_ui_plain_move "$terminal_fd" "$plain_echo" fwd "${value:cursor}"; cursor=${#value} ;;
      backspace)
        if ((cursor > 0)); then
          local removed="${value:cursor-1:1}"
          value="${value:0:cursor-1}${value:cursor}"
          cursor=$((cursor - 1))
          installer_ui_plain_edit "$terminal_fd" "$plain_echo" "$removed" "" "${value:cursor}" "$removed"
        fi
        ;;
      delete)
        if ((cursor < ${#value})); then
          local removed="${value:cursor:1}"
          value="${value:0:cursor}${value:cursor+1}"
          installer_ui_plain_edit "$terminal_fd" "$plain_echo" "" "" "${value:cursor}" "$removed"
        fi
        ;;
      paste-start)
        installer_ui_read_paste "$terminal_fd" "$((maximum - ${#value}))" insert || {
          status=$?
          break
        }
        value="${value:0:cursor}${insert}${value:cursor}"
        cursor=$((cursor + ${#insert}))
        installer_ui_plain_edit "$terminal_fd" "$plain_echo" "" "$insert" "${value:cursor}" ""
        ;;
      char:*)
        insert="${key#char:}"
        ((${#value} < maximum)) || {
          status=2
          break
        }
        value="${value:0:cursor}${insert}${value:cursor}"
        cursor=$((cursor + ${#insert}))
        installer_ui_plain_edit "$terminal_fd" "$plain_echo" "" "$insert" "${value:cursor}" ""
        ;;
      *) ;;
    esac

    if [[ "$visibility" == text && "$repaint" == 1 ]]; then
      printf '\r\033[2K%s%s' "$prompt" "$value" >&"$terminal_fd"
      installer_ui_width "${value:cursor}"
      tail=$installer_ui_width_result
      ((tail == 0)) || printf '\033[%dD' "$tail" >&"$terminal_fd"
    fi
  done
  printf '\n' >&"$terminal_fd"
  stty "$saved_state" <&"$terminal_fd" 2>/dev/null || restore_status=1
  installer_ui_restore_traps
  [[ "$restore_status" == 0 ]] || return 1
  [[ "$interrupted" == 0 ]] || return 130
  [[ "$status" == 0 ]] || return "$status"
  [[ ${#value} -le maximum ]] || return 2
  [[ "$value" != *$'\033'* && ! "$value" =~ [[:cntrl:]] ]] || return 2
  printf '%s' "$value"
}

installer_ui_read_text() {
  installer_ui_read_value "$1" "$2" "$3" text
}

installer_ui_read_secret() {
  installer_ui_read_value "$1" "$2" "$3" secret
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "${1:-}" == --plain || "${1:-}" == --tty ]]; then
    installer_ui_init "$1"
    shift
  else
    installer_ui_init
  fi
  installer_ui_emit "$@"
fi
