#!/usr/bin/env bash
printf '%s\n' "$*" >> "$S/argv.log"
[[ -e "$S/passthrough" ]] && exec "$BASE" "$@"
state_of() { cat "$S/$1" 2>/dev/null || true; }
svc_of_id() { case "$1" in "$DB_ID") echo orbit-db ;; "$APP_ID") echo orbit-app ;; esac; }
id_of_svc() { case "$1" in orbit-db) echo "$DB_ID" ;; orbit-app) echo "$APP_ID" ;; esac; }
case "${1:-}" in
  ps)
    svc=''; all=0; want_running=0; want_restarting=0; fmt=''
    args=("$@")
    for (( i = 1; i < ${#args[@]}; i++ )); do
      a="${args[$i]}"
      case "$a" in
        label=com.docker.compose.service=*) svc="${a##*=}" ;;
        -a|--all) all=1 ;;
        status=running) want_running=1 ;;
        status=restarting) want_restarting=1 ;;
        --format) fmt="${args[$((i + 1))]:-}" ;;
      esac
    done
    if [[ -n "$svc" ]]; then
      if [[ "$want_restarting" == 1 && -e "$S/restarting-probe-fails" ]]; then printf "Cannot connect to the Docker daemon\n" >&2; exit 1; fi
      st="$(state_of "$svc")"
      [[ -z "$st" ]] && exit 0
      if [[ "$want_running" == 1 && "$st" != running ]]; then exit 0; fi
      if [[ "$want_restarting" == 1 && "$st" != restarting ]]; then exit 0; fi
      if [[ "$want_restarting" == 1 && -e "$S/multi-restarting" ]]; then printf '%s\n%s\n' "$(id_of_svc "$svc")" "ffff00001111"; exit 0; fi
      if [[ "$st" == stopped && "$all" == 0 ]]; then exit 0; fi
      if [[ "$fmt" == *'.State}}'* || "$fmt" == *'.Status}}'* ]]; then
        out="$fmt"
        id="$(id_of_svc "$svc")"
        out="${out//'{{.ID}}'/$id}"
        out="${out//'{{.Names}}'/repairtest-$svc-1}"
        out="${out//'{{.Label "com.docker.compose.service"}}'/$svc}"
        if [[ "$st" == restarting ]]; then
          out="${out//'{{.State}}'/restarting}"; out="${out//'{{.Status}}'/Restarting (1) 3 seconds ago}"
        elif [[ "$st" == running ]]; then
          out="${out//'{{.State}}'/running}"; out="${out//'{{.Status}}'/Up 2 hours}"
        else
          out="${out//'{{.State}}'/exited}"; out="${out//'{{.Status}}'/Exited (1) 2 hours ago}"
        fi
        printf '%s\n' "$out"
        exit 0
      fi
    fi
    ;;
  inspect)
    target="${!#}"; svc="$(svc_of_id "$target")"
    if [[ -n "$svc" ]]; then
      st="$(state_of "$svc")"
      if [[ -z "$st" ]]; then printf 'Error: No such object: %s\n' "$target" >&2; exit 1; fi
      case "$*" in
        *'{{.State.Status}}'*) case "$st" in running) echo running ;; restarting) echo restarting ;; *) echo exited ;; esac; exit 0 ;;
        *'{{.State.Running}}'*) [[ "$st" == running || "$st" == restarting ]] && echo true || echo false; exit 0 ;;
        *'{{.State.Restarting}}'*) [[ "$st" == restarting ]] && echo true || echo false; exit 0 ;;
      esac
      if [[ "$st" == stopped ]]; then exit 1; fi
    fi
    ;;
  exec)
    for a in "$@"; do
      svc="$(svc_of_id "$a")"
      if [[ -n "$svc" ]]; then
        st="$(state_of "$svc")"
        if [[ "$st" == restarting ]]; then
          printf 'Error response from daemon: Container %s is restarting, wait until the container is running\n' "$a" >&2; exit 1
        fi
        if [[ "$st" != running ]]; then
          printf 'Error response from daemon: container %s is not running\n' "$a" >&2; exit 1
        fi
        if [[ "$*" == *pg_isready* && -e "$S/db-not-ready" ]]; then exit 1; fi
      fi
    done
    ;;
  volume)
    if [[ "${2:-}" == ls && -e "$S/volumes-vanished" ]]; then exit 0; fi
    ;;
  compose)
    is_up=0
    for a in "$@"; do [[ "$a" == up ]] && is_up=1; done
    if [[ "$is_up" == 1 ]]; then
      if [[ -e "$S/up-fails" ]]; then cat "$S/up-stderr" >&2; exit 1; fi
      recreate=0; [[ "$*" == *--force-recreate* ]] && recreate=1
      for svc in orbit-db orbit-app; do
        st="$(state_of "$svc")"
        if [[ "$st" == running && "$recreate" == 1 ]]; then printf recreated > "$S/$svc"; continue; fi
        [[ "$st" == running ]] || printf running > "$S/$svc"
      done
      exit 0
    fi
    ;;
esac
exec "$BASE" "$@"
