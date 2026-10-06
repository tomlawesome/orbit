#!/usr/bin/env bash
# Lists, and with --remove tears down, every Docker Compose project on this
# host whose name starts with "orbit" (#1241): containers (stopped and profile
# ones too), volumes and networks. A stack a script started must not outlive
# it; this is the sweep that catches the ones that did anyway.
#
#   bash scripts/cleanup-stacks.sh                  list only; changes nothing
#   bash scripts/cleanup-stacks.sh --remove         tear down what it listed
#   bash scripts/cleanup-stacks.sh --project NAME   limit to one orbit* project
#   bash scripts/cleanup-stacks.sh --include-ollama also remove orbit-ollama and
#                                                   its model volume (kept by
#                                                   default: the model download
#                                                   is large)
#
# Projects are found by the com.docker.compose.project label, not by name, so
# a stopped container counts, and so do networks and volumes left behind with
# no container at all (fourteen such networks once used up Docker's address
# pools and put a new stack on the owner's LAN range). Containers Compose did
# not create (a `docker run` review container) are listed and never removed.
# Output is plain text, never coloured.
set -uo pipefail

PROJECT_LABEL='com.docker.compose.project'
OLLAMA_SERVICE='orbit-ollama'

usage() {
  sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
}

remove=false
include_ollama=false
only_project=""

while [ $# -gt 0 ]; do
  case "$1" in
    --remove) remove=true ;;
    --include-ollama) include_ollama=true ;;
    --project)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "--project needs a project name." >&2
        exit 2
      fi
      only_project="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

case "$only_project" in
  "" | orbit*) ;;
  *)
    echo "Refusing --project $only_project: this script only touches projects whose name starts with \"orbit\"." >&2
    exit 2
    ;;
esac

# project|id|name|status|image|service|networks  (project is empty for a
# container Compose did not create)
containers="$(docker ps -a --format "{{.Label \"$PROJECT_LABEL\"}}|{{.ID}}|{{.Names}}|{{.Status}}|{{.Image}}|{{.Label \"com.docker.compose.service\"}}|{{.Networks}}")" || {
  echo "Could not list containers: is Docker running and reachable?" >&2
  exit 1
}
volumes="$(docker volume ls --filter "label=$PROJECT_LABEL" --format "{{.Label \"$PROJECT_LABEL\"}}|{{.Name}}")" || {
  echo "Could not list volumes." >&2
  exit 1
}
networks="$(docker network ls --filter "label=$PROJECT_LABEL" --format "{{.Label \"$PROJECT_LABEL\"}}|{{.Name}}")" || {
  echo "Could not list networks." >&2
  exit 1
}

wanted_project() {
  case "$1" in
    orbit*) [ -z "$only_project" ] || [ "$1" = "$only_project" ] ;;
    *) return 1 ;;
  esac
}

is_ollama_container() { [ "$1" = "$OLLAMA_SERVICE" ]; }
is_ollama_volume() { case "$1" in *ollama-data) return 0 ;; *) return 1 ;; esac; }

# Every orbit* project that owns at least one container, volume or network.
projects="$(
  {
    printf '%s\n' "$containers" | cut -d'|' -f1
    printf '%s\n' "$volumes" | cut -d'|' -f1
    printf '%s\n' "$networks" | cut -d'|' -f1
  } | sort -u | while IFS= read -r p; do
    [ -n "$p" ] && wanted_project "$p" && printf '%s\n' "$p"
  done
)"

failures=0
kept_ollama=false
kept_networks=""

# Networks the kept ollama container is attached to cannot be removed while it
# runs, so they are kept with it rather than reported as failures.
if [ "$include_ollama" != true ]; then
  while IFS='|' read -r proj _ _ _ _ service nets; do
    [ -n "$proj" ] || continue
    wanted_project "$proj" || continue
    is_ollama_container "$service" || continue
    kept_networks="$kept_networks,$nets,"
  done <<<"$containers"
fi

if [ -z "$projects" ]; then
  if [ -n "$only_project" ]; then
    echo "No Compose project named $only_project found."
  else
    echo "No orbit* Compose projects found on this host."
  fi
else
  while IFS= read -r project; do
    echo "Project: $project"
    echo "  Containers:"
    found=false
    while IFS='|' read -r proj id name status image service _; do
      [ "$proj" = "$project" ] || continue
      found=true
      suffix=""
      if [ "$include_ollama" != true ] && is_ollama_container "$service"; then
        suffix="  [kept: language model service]"
      fi
      echo "    $name ($status) image $image$suffix"
    done <<<"$containers"
    [ "$found" = true ] || echo "    none"

    echo "  Volumes:"
    found=false
    while IFS='|' read -r proj name; do
      [ "$proj" = "$project" ] || continue
      found=true
      suffix=""
      if [ "$include_ollama" != true ] && is_ollama_volume "$name"; then
        suffix="  [kept: language model download]"
      fi
      echo "    $name$suffix"
    done <<<"$volumes"
    [ "$found" = true ] || echo "    none"

    echo "  Networks:"
    found=false
    while IFS='|' read -r proj name; do
      [ "$proj" = "$project" ] || continue
      found=true
      suffix=""
      case "$kept_networks" in
        *",$name,"*) suffix="  [kept: the language model container is attached]" ;;
      esac
      echo "    $name$suffix"
    done <<<"$networks"
    [ "$found" = true ] || echo "    none"
    echo
  done <<<"$projects"
fi

# Containers Compose did not create are never removed, whatever their name.
foreign="$(
  while IFS='|' read -r proj _ name status image _; do
    [ -z "$proj" ] && [ -n "$name" ] && printf '    %s (%s) image %s\n' "$name" "$status" "$image"
  done <<<"$containers"
)"
if [ -n "$foreign" ]; then
  echo "Not Compose-managed, left alone:"
  printf '%s\n' "$foreign"
  echo
fi

try() {
  # try DESCRIPTION CMD...: run a removal, print what it did, count failures.
  local description="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "  Removed $description"
  else
    echo "  COULD NOT REMOVE $description" >&2
    failures=$((failures + 1))
  fi
}

ollama_note() {
  echo "Kept the orbit-ollama service and its model volume: the language model download is large."
  echo "Run with --remove --include-ollama to remove them too."
}

if [ "$remove" != true ]; then
  if [ -n "$projects" ]; then
    if [ "$include_ollama" != true ] && { printf '%s\n' "$containers" | grep -q "|$OLLAMA_SERVICE|" || printf '%s\n' "$volumes" | grep -q 'ollama-data$'; }; then
      ollama_note
    fi
    echo "Nothing was changed. Run with --remove to tear these down."
  fi
  exit 0
fi

[ -n "$projects" ] || exit 0

echo "Removing:"
# Containers first (a network or volume cannot go while one still uses it).
while IFS='|' read -r proj id name _ _ service _; do
  [ -n "$proj" ] || continue
  wanted_project "$proj" || continue
  if [ "$include_ollama" != true ] && is_ollama_container "$service"; then
    kept_ollama=true
    continue
  fi
  try "container $name" docker rm -f -v "$id"
done <<<"$containers"

while IFS='|' read -r proj name; do
  [ -n "$proj" ] || continue
  wanted_project "$proj" || continue
  if [ "$include_ollama" != true ] && is_ollama_volume "$name"; then
    kept_ollama=true
    continue
  fi
  try "volume $name" docker volume rm "$name"
done <<<"$volumes"

while IFS='|' read -r proj name; do
  [ -n "$proj" ] || continue
  wanted_project "$proj" || continue
  case "$kept_networks" in
    *",$name,"*) continue ;;
  esac
  try "network $name" docker network rm "$name"
done <<<"$networks"

if [ "$kept_ollama" = true ]; then
  echo
  ollama_note
fi

if [ "$failures" -gt 0 ]; then
  echo
  echo "$failures item(s) could not be removed (see above)." >&2
  exit 1
fi
echo "Done."
