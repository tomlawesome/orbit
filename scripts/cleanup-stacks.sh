#!/usr/bin/env bash
# Lists, and with --remove tears down, every Docker Compose project on this
# host whose name starts with "orbit" (#1241): containers (stopped and profile
# ones too), volumes and networks. A stack a script started must not outlive
# it; this is the sweep that catches the ones that did anyway.
#
#   bash scripts/cleanup-stacks.sh                  list only; changes nothing
#   bash scripts/cleanup-stacks.sh --remove         tear down the stale projects
#                                                   (nothing running); a project
#                                                   with a running container is
#                                                   skipped, since another
#                                                   session may be using it
#   bash scripts/cleanup-stacks.sh --project NAME   limit to one orbit* project;
#                                                   with --remove, removes it
#                                                   even if it is running
#   bash scripts/cleanup-stacks.sh --remove --all   remove running projects too
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
# Also lists the locally built images (orbit-local, orbit-vapid-bootstrap,
# orbit-acceptance-local) that no container uses; plain --remove or --all
# removes those by name, never with -f and never by pruning. They belong to no
# project, so --project leaves them alone.
# Output is plain text, never coloured.
set -uo pipefail

PROJECT_LABEL='com.docker.compose.project'
OLLAMA_SERVICE='orbit-ollama'
# Repositories of images the scripts build locally. Exact names only.
IMAGE_REPOS='orbit-local orbit-vapid-bootstrap orbit-acceptance-local'

usage() {
  sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
}

remove=false
include_ollama=false
all_projects=false
only_project=""

while [ $# -gt 0 ]; do
  case "$1" in
    --remove) remove=true ;;
    --include-ollama) include_ollama=true ;;
    --all) all_projects=true ;;
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

# Names of a project's running containers, comma-separated. A kept orbit-ollama
# does not count: it stays regardless, so it must not shield the rest.
running_containers() {
  local project="$1" out="" proj name status service
  while IFS='|' read -r proj _ name status _ service _; do
    [ "$proj" = "$project" ] || continue
    case "$status" in
      Up* | Restarting*) ;;
      *) continue ;;
    esac
    if [ "$include_ollama" != true ] && is_ollama_container "$service"; then
      continue
    fi
    out="${out:+$out, }$name"
  done <<<"$containers"
  printf '%s' "$out"
}

# Plain --remove leaves a running project alone; naming it with --project, or
# --all, is the explicit go-ahead.
selected_for_removal() {
  [ "$all_projects" = true ] || [ -n "$only_project" ] || [ -z "$(running_containers "$1")" ]
}

# Sets $images to one row per locally built image:
#   repository|tag|id|age|size|used     (used is "yes" when any container, in any
# state and any project, was created from it). Returns non-zero when Docker
# cannot say, so nothing is ever removed on a guess.
images=""
fetch_images() {
  local listed ids used_ids="" repo tag id age size row keep r
  listed="$(docker image ls --no-trunc --format '{{.Repository}}|{{.Tag}}|{{.ID}}|{{.CreatedSince}}|{{.Size}}')" || return 1
  ids="$(docker ps -a -q)" || return 1
  if [ -n "$ids" ]; then
    local -a id_array
    mapfile -t id_array <<<"$ids"
    used_ids="$(docker inspect --format '{{.Image}}' "${id_array[@]}")" || return 1
  fi
  images=""
  while IFS='|' read -r repo tag id age size; do
    [ -n "$repo" ] || continue
    keep=false
    for r in $IMAGE_REPOS; do
      [ "$repo" = "$r" ] && keep=true
    done
    [ "$keep" = true ] || continue
    row="$repo|$tag|$id|$age|$size|no"
    if [ -n "$used_ids" ] && printf '%s\n' "$used_ids" | grep -qxF -- "$id"; then
      row="$repo|$tag|$id|$age|$size|yes"
    fi
    images="${images:+$images$'\n'}$row"
  done <<<"$listed"
}

failures=0
skipped=0
ollama_listed=false
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
    if [ -n "$(running_containers "$project")" ]; then
      echo "Project: $project (running)"
    else
      echo "Project: $project (stale)"
    fi
    echo "  Containers:"
    found=false
    while IFS='|' read -r proj id name status image service _; do
      [ "$proj" = "$project" ] || continue
      found=true
      suffix=""
      if [ "$include_ollama" != true ] && is_ollama_container "$service"; then
        suffix="  [kept: language model service]"
        ollama_listed=true
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
        ollama_listed=true
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

images_ok=true
unused_images=0
fetch_images || {
  images_ok=false
  echo "Could not tell which locally built images are in use, so images are left alone." >&2
  failures=$((failures + 1))
}
if [ "$images_ok" = true ] && [ -n "$images" ]; then
  echo "Locally built images (not part of any project):"
  while IFS='|' read -r repo tag _ age size used; do
    if [ "$used" = yes ]; then
      echo "    $repo:$tag ($age, $size) in use, kept"
    else
      echo "    $repo:$tag ($age, $size) unused"
      unused_images=$((unused_images + 1))
    fi
  done <<<"$images"
  if [ -n "$only_project" ]; then
    echo "  Images are not removed when --project is used."
  fi
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
  if [ "$ollama_listed" = true ]; then
    ollama_note
  fi
  if [ -n "$projects" ] || [ "$unused_images" -gt 0 ]; then
    echo "Nothing was changed. --remove tears down the stale projects and removes unused images; a running project needs --project NAME --remove, or --all."
  fi
  [ "$failures" -eq 0 ] || exit 1
  exit 0
fi

echo "Removing:"
for project in $projects; do
  if ! selected_for_removal "$project"; then
    echo "  $project skipped: running ($(running_containers "$project")) -- remove it with --project $project --remove, or --all"
    skipped=$((skipped + 1))
  fi
done
# Containers first (a network or volume cannot go while one still uses it).
while IFS='|' read -r proj id name _ _ service _; do
  [ -n "$proj" ] || continue
  wanted_project "$proj" || continue
  selected_for_removal "$proj" || continue
  if [ "$include_ollama" != true ] && is_ollama_container "$service"; then
    kept_ollama=true
    continue
  fi
  try "container $name" docker rm -f -v "$id"
done <<<"$containers"

while IFS='|' read -r proj name; do
  [ -n "$proj" ] || continue
  wanted_project "$proj" || continue
  selected_for_removal "$proj" || continue
  if [ "$include_ollama" != true ] && is_ollama_volume "$name"; then
    kept_ollama=true
    continue
  fi
  try "volume $name" docker volume rm "$name"
done <<<"$volumes"

while IFS='|' read -r proj name; do
  [ -n "$proj" ] || continue
  wanted_project "$proj" || continue
  selected_for_removal "$proj" || continue
  case "$kept_networks" in
    *",$name,"*) continue ;;
  esac
  try "network $name" docker network rm "$name"
done <<<"$networks"

# Images last: a container removed above frees its image, so ask Docker again
# rather than trusting the listing made before the removals.
if [ -z "$only_project" ] && [ "$images_ok" = true ]; then
  if fetch_images; then
    while IFS='|' read -r repo tag _ _ _ used; do
      [ -n "$repo" ] || continue
      [ "$used" = no ] || continue
      try "image $repo:$tag" docker image rm "$repo:$tag"
    done <<<"$images"
  else
    echo "Could not tell which locally built images are in use, so images were left alone." >&2
    failures=$((failures + 1))
  fi
fi

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
