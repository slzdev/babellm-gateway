#!/usr/bin/env bash
#
# Build the gateway image and push it to ghcr.io/slzdev/babellm-gateway.
#
# Usage:
#   scripts/docker-publish.sh                      # build + push :latest, :<version>, :<git-sha>
#   scripts/docker-publish.sh -t v1.2.3            # add an extra tag (repeatable)
#   scripts/docker-publish.sh --platform linux/amd64,linux/arm64
#   scripts/docker-publish.sh --no-push            # build only, load into the local daemon
#   scripts/docker-publish.sh --dry-run            # print the docker command and exit
#
# Authentication is not handled here: log in yourself first with a GitHub PAT
# that has `write:packages`, e.g.
#
#   echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/slzdev/babellm-gateway}"
PLATFORM="${PLATFORM:-linux/amd64,linux/arm64}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

extra_tags=()
push=true
dry_run=false

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag)      [[ $# -ge 2 ]] || die "$1 needs a value"; extra_tags+=("$2"); shift 2 ;;
    --platform)    [[ $# -ge 2 ]] || die "$1 needs a value"; PLATFORM="$2"; shift 2 ;;
    --image)       [[ $# -ge 2 ]] || die "$1 needs a value"; IMAGE="$2"; shift 2 ;;
    --no-push)     push=false; shift ;;
    --dry-run)     dry_run=true; shift ;;
    -h|--help)     awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *)             die "unknown argument: $1" ;;
  esac
done

command -v docker >/dev/null || die "docker is not installed"
docker buildx version >/dev/null 2>&1 || die "docker buildx is required"

# ---- tags -------------------------------------------------------------------
version="$(node -p "require('./package.json').version")"
sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  sha="${sha}-dirty"
  echo "warning: working tree is dirty; tagging the sha as ${sha}" >&2
fi

tags=("latest" "$version" "$sha" "${extra_tags[@]+"${extra_tags[@]}"}")

tag_args=()
for tag in "${tags[@]}"; do
  tag_args+=(--tag "${IMAGE}:${tag}")
done

# ---- builder ----------------------------------------------------------------
# The default `docker` driver cannot produce multi-platform images, so fall back
# to a dedicated docker-container builder when more than one platform is asked
# for.
builder_args=()
if [[ "$PLATFORM" == *,* ]]; then
  if ! docker buildx inspect babellm-builder >/dev/null 2>&1 && ! $dry_run; then
    echo "==> creating buildx builder 'babellm-builder' for multi-platform builds"
    docker buildx create --name babellm-builder --driver docker-container >/dev/null
  fi
  builder_args+=(--builder babellm-builder)
fi

if $push; then
  output_args=(--push)
elif [[ "$PLATFORM" == *,* ]]; then
  # A multi-platform image has no single-image representation to load.
  output_args=()
  echo "warning: --no-push with multiple platforms discards the result" >&2
else
  output_args=(--load)
fi

cmd=(docker buildx build "${builder_args[@]+"${builder_args[@]}"}"
     --platform "$PLATFORM"
     "${tag_args[@]}"
     --label "org.opencontainers.image.source=https://github.com/slzdev/babellm-gateway"
     --label "org.opencontainers.image.revision=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
     --label "org.opencontainers.image.version=${version}"
     "${output_args[@]+"${output_args[@]}"}"
     .)

if $dry_run; then
  printf '%q ' "${cmd[@]}"; echo
  exit 0
fi

echo "==> building ${IMAGE} for ${PLATFORM}"
for tag in "${tags[@]}"; do echo "      ${IMAGE}:${tag}"; done

"${cmd[@]}"

if $push; then
  echo "==> pushed ${IMAGE} (${tags[*]})"
  echo "    docker pull ${IMAGE}:${version}"
else
  echo "==> built locally (not pushed)"
fi
