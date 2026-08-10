#!/usr/bin/env bash

# Shared semantic renderer for the installer command centre. Callers pass only
# fixed vocabulary values; invalid values are rendered as "unknown" rather
# than copied into operator-visible output.

installer_ui_mode="plain"
installer_ui_started_at=0

installer_ui_init() {
  local requested_mode=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --plain)
        requested_mode="plain"
        ;;
      --tty)
        requested_mode="tty"
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
    reason:initial|reason:target|reason:channel|reason:digest|reason:source-revision|reason:semantic-version|reason:revision|reason:configuration|reason:configuration-required|reason:discovery|reason:compose-config|reason:database-image|reason:service-start|reason:status-verified|reason:installed|reason:host-tools|reason:image-identity|reason:assets-verified|reason:configuration-migration|reason:provider-discovery|reason:compose-validation|reason:service-preparation|reason:database-health|reason:application-health|reason:optional-status|reason:deployment-ready|reason:docker-host|reason:image-registry|reason:configuration-failure|reason:provider-unavailable|reason:database-auth-migration|reason:application-startup|reason:health-timeout|reason:optional-unavailable|reason:failure|reason:rollback|reason:repair-unavailable|reason:unknown)
      printf '%s' "$value"
      ;;
    action:begin|action:validate|action:pull|action:inspect|action:fetch|action:configure|action:verify|action:check|action:start|action:wait|action:health|action:skip|action:status|action:complete|action:retry|action:rollback|action:repair|action:continue|action:display)
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

  local phase component state reason action elapsed
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

  if [[ "$installer_ui_mode" == tty ]]; then
    local state_color='\033[33m' width
    case "$state" in
      waiting|starting|running) state_color='\033[36m' ;;
      healthy|completed) state_color='\033[32m' ;;
      skipped) state_color='\033[33m' ;;
      blocked|failed) state_color='\033[31m' ;;
    esac
    width="$(installer_ui_terminal_width 1)"
    if ((width < 60)); then
      printf '[%s] %s %b%s\033[0m %s\n' \
        "$elapsed" "$component" "$state_color" "$state" "$reason"
    else
      printf '[%s] %-13s %-12s %b%-9s\033[0m %s / %s\n' \
        "$elapsed" "$phase" "$component" "$state_color" "$state" "$reason" "$action"
    fi
  else
    printf 'phase=%s component=%s state=%s reason=%s action=%s elapsed=%s\n' \
      "$phase" "$component" "$state" "$reason" "$action" "$elapsed"
  fi
}

installer_ui_read_key() {
  local terminal_fd="$1" key next read_status=0

  IFS= read -r -s -n 1 -t 0.2 -u "$terminal_fd" key || read_status=$?
  if [[ "$read_status" != 0 ]]; then
    if ((read_status > 128)); then
      printf 'timeout'
      return 0
    fi
    return "$read_status"
  fi
  if [[ -z "$key" ]]; then
    printf 'enter'
    return 0
  fi
  if [[ "$key" != $'\033' ]]; then
    case "$key" in
      $'\004') return 1 ;;
      $'\177'|$'\b') printf 'backspace' ;;
      [[:print:]]) printf 'char:%s' "$key" ;;
      *) printf 'ignore' ;;
    esac
    return 0
  fi

  if ! IFS= read -r -s -n 1 -t 0.08 -u "$terminal_fd" next; then
    printf 'escape'
    return 0
  fi
  if [[ "$next" == "]" ]]; then
    # OSC strings are presentation-only. Consume them through BEL or the
    # two-byte ST terminator so a title/icon sequence cannot leak into a
    # value as ordinary text.
    local osc_byte="" osc_index
    for ((osc_index = 0; osc_index < 256; osc_index++)); do
      if ! IFS= read -r -s -n 1 -t 0.08 -u "$terminal_fd" osc_byte; then
        printf 'ignore'
        return 0
      fi
      case "$osc_byte" in
        $'\a') printf 'ignore'; return 0 ;;
        $'\033')
          if IFS= read -r -s -n 1 -t 0.08 -u "$terminal_fd" osc_byte &&
            [[ "$osc_byte" == "\\" ]]; then
            printf 'ignore'
          else
            printf 'ignore'
          fi
          return 0
          ;;
      esac
    done
    printf 'ignore'
    return 0
  fi

  if [[ "$next" == "[" || "$next" == "O" ]]; then
    # CSI/SS3 sequences end at an ASCII final byte. Reading to that boundary
    # keeps unsupported parameters (for example ESC [ 1 ; 2 A) from being
    # reinterpreted as user text. The bound prevents a malformed sequence
    # from monopolising an input widget indefinitely.
    local prefix="$next" sequence="" final="" sequence_byte="" sequence_index
    for ((sequence_index = 0; sequence_index < 32; sequence_index++)); do
      if ! IFS= read -r -s -n 1 -t 0.08 -u "$terminal_fd" sequence_byte; then
        printf 'ignore'
        return 0
      fi
      if [[ "$sequence_byte" == [@-~] ]]; then
        final="$sequence_byte"
        break
      fi
      [[ "$sequence_byte" != $'\033' ]] || {
        printf 'ignore'
        return 0
      }
      sequence+="$sequence_byte"
    done
    [[ -n "$final" ]] || {
      printf 'ignore'
      return 0
    }

    if [[ "$prefix" == "O" && -z "$sequence" ]]; then
      case "$final" in
        A) printf 'up'; return 0 ;;
        B) printf 'down'; return 0 ;;
        C) printf 'right'; return 0 ;;
        D) printf 'left'; return 0 ;;
        H) printf 'home'; return 0 ;;
        F) printf 'end'; return 0 ;;
      esac
    fi

    case "$sequence$final" in
      A) printf 'up' ;;
      B) printf 'down' ;;
      C) printf 'right' ;;
      D) printf 'left' ;;
      H) printf 'home' ;;
      F) printf 'end' ;;
      1~|7~) printf 'home' ;;
      3~) printf 'delete' ;;
      4~|8~) printf 'end' ;;
      200~) printf 'paste-start' ;;
      201~) printf 'paste-end' ;;
      *) printf 'ignore' ;;
    esac
    return 0
  fi

  printf 'ignore'
  return 0
}

installer_ui_read_paste() {
  local terminal_fd="$1" maximum="$2" byte payload="" marker=$'\033[201~' read_status=0 idle_timeouts=0
  while true; do
    read_status=0
    IFS= read -r -s -n 1 -t 0.2 -u "$terminal_fd" byte || read_status=$?
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
    [[ -n "$byte" ]] || byte=$'\n'
    payload+="$byte"
    if [[ "$payload" == *"$marker" ]]; then
      payload="${payload%"$marker"}"
      break
    fi
    ((${#payload} <= maximum + ${#marker})) || return 2
  done
  ((${#payload} <= maximum)) || return 2
  [[ "$payload" != *$'\033'* && ! "$payload" =~ [[:cntrl:]] ]] || return 2
  printf '%s' "$payload"
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

installer_ui_menu_render() {
  local terminal_fd="$1" selected="$2"
  shift 2
  local index=0 label marker fitted
  while [[ $# -gt 0 ]]; do
    label="$2"
    shift 2
    fitted="$(installer_ui_fit_menu_label "$terminal_fd" "$label")"
    marker=" "
    [[ "$index" == "$selected" ]] && marker=">"
    printf '%s %d) %s\n' "$marker" "$((index + 1))" "$fitted" >&"$terminal_fd"
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
  local count selected=0 index key fitted
  count=$((${#items[@]} / 2))

  for ((index = 0; index < count; index++)); do
    [[ "${items[index * 2]}" == "$default_id" ]] && selected="$index"
  done

  printf '%s\n\n' "$prompt" >&"$terminal_fd"
  if [[ -t "$terminal_fd" && "${TERM:-}" != dumb ]]; then
    installer_ui_menu_render "$terminal_fd" "$selected" "${items[@]}"
    while true; do
      key="$(installer_ui_read_key "$terminal_fd")" || return 1
      case "$key" in
        up) selected=$(((selected + count - 1) % count)) ;;
        down) selected=$(((selected + 1) % count)) ;;
        enter)
          printf '%s' "${items[selected * 2]}"
          return 0
          ;;
        escape) return 130 ;;
        char:[1-9])
          index="${key#char:}"
          if ((index >= 1 && index <= count)); then
            printf '%s' "${items[(index - 1) * 2]}"
            return 0
          fi
          ;;
        timeout) continue ;;
        *) continue ;;
      esac
      printf '\033[%dA' "$count" >&"$terminal_fd"
      for ((index = 0; index < count; index++)); do
        printf '\r\033[2K' >&"$terminal_fd"
        fitted="$(installer_ui_fit_menu_label "$terminal_fd" "${items[index * 2 + 1]}")"
        if [[ "$index" == "$selected" ]]; then
          printf '> %d) %s\n' "$((index + 1))" "$fitted" >&"$terminal_fd"
        else
          printf '  %d) %s\n' "$((index + 1))" "$fitted" >&"$terminal_fd"
        fi
      done
    done
  fi

  installer_ui_menu_render "$terminal_fd" "$selected" "${items[@]}"
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

installer_ui_read_value() {
  [[ $# -eq 4 ]] || return 2
  local terminal_fd="$1" prompt="$2" maximum="$3" visibility="$4"
  local value="" saved_state status=0 restore_status=0 interrupted=0 key insert="" cursor=0 tail=0 repaint=1
  [[ "$maximum" =~ ^[1-9][0-9]{0,5}$ ]] || return 2
  [[ "$visibility" == text || "$visibility" == secret ]] || return 2
  [[ "${TERM:-}" != dumb && "${ORBIT_INSTALLER_PLAIN:-0}" != 1 ]] || repaint=0

  saved_state="$(stty -g <&"$terminal_fd" 2>/dev/null)" || return 1
  stty -echo -icanon min 1 time 0 <&"$terminal_fd" 2>/dev/null || return 1
  trap 'interrupted=1' INT TERM HUP
  printf '%s' "$prompt" >&"$terminal_fd"
  while true; do
    key="$(installer_ui_read_key "$terminal_fd")" || {
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
      left) ((cursor > 0)) && cursor=$((cursor - 1)) ;;
      right) ((cursor < ${#value})) && cursor=$((cursor + 1)) ;;
      home) cursor=0 ;;
      end) cursor=${#value} ;;
      backspace)
        if ((cursor > 0)); then
          value="${value:0:cursor-1}${value:cursor}"
          cursor=$((cursor - 1))
        fi
        ;;
      delete)
        if ((cursor < ${#value})); then
          value="${value:0:cursor}${value:cursor+1}"
        fi
        ;;
      paste-start)
        insert="$(installer_ui_read_paste "$terminal_fd" "$((maximum - ${#value}))")" || {
          status=$?
          break
        }
        value="${value:0:cursor}${insert}${value:cursor}"
        cursor=$((cursor + ${#insert}))
        ;;
      char:*)
        insert="${key#char:}"
        ((${#value} < maximum)) || {
          status=2
          break
        }
        value="${value:0:cursor}${insert}${value:cursor}"
        cursor=$((cursor + ${#insert}))
        ;;
      *) ;;
    esac

    if [[ "$visibility" == text && "$repaint" == 1 ]]; then
      printf '\r\033[2K%s%s' "$prompt" "$value" >&"$terminal_fd"
      tail=$((${#value} - cursor))
      ((tail == 0)) || printf '\033[%dD' "$tail" >&"$terminal_fd"
    fi
  done
  printf '\n' >&"$terminal_fd"
  stty "$saved_state" <&"$terminal_fd" 2>/dev/null || restore_status=1
  trap - INT TERM HUP
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
