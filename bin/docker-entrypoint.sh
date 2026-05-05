#!/usr/bin/env bash
set -euo pipefail

seed_opencode_home() {
  local template_dir="/opt/opencode-home/.config/opencode"
  local target_dir="${HOME}/.config/opencode"

  mkdir -p "${HOME}/.config"
  if [[ ! -d "${target_dir}/node_modules" ]]; then
    mkdir -p "${target_dir}"
    if [[ -d "${template_dir}" ]]; then
      cp -R "${template_dir}/." "${target_dir}/"
    fi
  fi

  if [[ "${BENCH_DOCKER_IMPORT_OPENCODE_HOME:-0}" != "1" || ! -d /inputs/opencode-home ]]; then
    return
  fi

  shopt -s dotglob nullglob
  for candidate in /inputs/opencode-home/*; do
    local base
    base="$(basename "${candidate}")"
    if [[ "${base}" == "node_modules" ]]; then
      continue
    fi
    cp -R "${candidate}" "${target_dir}/"
  done
  shopt -u dotglob nullglob
}

source_hash() {
  tar \
    --sort=name \
    --mtime='UTC 2024-01-01' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    -C /inputs/akm-src \
    -cf - . | sha256sum | cut -d' ' -f1
}

prepare_source_akm() {
  if [[ ! -f /inputs/akm-src/package.json ]]; then
    printf 'docker-entrypoint: /inputs/akm-src/package.json not found\n' >&2
    exit 2
  fi

  local hash build_root install_root akm_bin
  hash="$(source_hash)"
  build_root="/cache/akm-source-builds/${hash}"
  install_root="${build_root}/src"
  akm_bin="${install_root}/node_modules/.bin/akm"

  if [[ ! -x "${akm_bin}" ]]; then
    rm -rf "${build_root}"
    mkdir -p "${install_root}"
    cp -R /inputs/akm-src/. "${install_root}/"
    if [[ -f "${install_root}/bun.lock" ]]; then
      (cd "${install_root}" && bun install --frozen-lockfile)
    else
      (cd "${install_root}" && bun install)
    fi
  fi

  if [[ ! -x "${akm_bin}" ]]; then
    printf 'docker-entrypoint: expected akm binary at %s after bun install\n' "${akm_bin}" >&2
    exit 2
  fi

  export AKM_BENCH_AKM_BIN="${akm_bin}"
  export PATH="$(dirname "${akm_bin}"):${PATH}"
}

configure_akm_runtime() {
  local mode default_bin
  mode="${BENCH_DOCKER_AKM_MODE:-installed}"
  default_bin="/opt/akm-bench/node_modules/.bin/akm"

  case "${mode}" in
    installed|version)
      export AKM_BENCH_AKM_BIN="${default_bin}"
      export PATH="$(dirname "${default_bin}"):${PATH}"
      ;;
    source)
      prepare_source_akm
      ;;
    *)
      printf 'docker-entrypoint: unsupported BENCH_DOCKER_AKM_MODE=%s\n' "${mode}" >&2
      exit 2
      ;;
  esac
}

mkdir -p /cache "${HOME}" "${BENCH_RESULTS_DIR:-/outputs}"
seed_opencode_home
configure_akm_runtime

exec "$@"
