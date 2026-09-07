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

source_archive() {
  if ! git -C /inputs/akm-src rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    printf 'docker-entrypoint: source mode requires a Git checkout so ignored files stay outside the build cache\n' >&2
    return 2
  fi
  (
    cd /inputs/akm-src
    git ls-files --cached --others --exclude-standard -z \
      | sort -z \
      | tar \
        --null \
        --no-recursion \
        --sort=name \
        --mtime='UTC 2024-01-01' \
        --owner=0 \
        --group=0 \
        --numeric-owner \
        -cf - \
        --files-from=-
  )
}

source_hash() {
  source_archive | sha256sum | cut -d' ' -f1
}

copy_source() {
  source_archive | tar -C "$1" -xf -
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
  akm_bin="${install_root}/dist/akm"

  if [[ ! -x "${akm_bin}" ]]; then
    rm -rf "${build_root}"
    mkdir -p "${install_root}"
    copy_source "${install_root}"
    if [[ -f "${install_root}/bun.lock" ]]; then
      (cd "${install_root}" && bun install --frozen-lockfile)
    else
      (cd "${install_root}" && bun install)
    fi
    (cd "${install_root}" && bun run build)
  fi

  if [[ ! -x "${akm_bin}" ]]; then
    printf 'docker-entrypoint: expected akm binary at %s after bun install\n' "${akm_bin}" >&2
    exit 2
  fi

  export AKM_BENCH_AKM_BIN="${akm_bin}"
  export AKM_BENCH_RUNTIME_FINGERPRINT="source:${hash}"
  export PATH="$(dirname "${akm_bin}"):${PATH}"
}

prepare_package_akm() {
  local package_file hash install_root akm_bin
  package_file="/inputs/akm-package/package.tgz"
  if [[ ! -f "${package_file}" ]]; then
    printf 'docker-entrypoint: %s not found\n' "${package_file}" >&2
    exit 2
  fi

  hash="$(sha256sum "${package_file}" | cut -d' ' -f1)"
  install_root="/cache/akm-packages/${hash}"
  akm_bin="${install_root}/node_modules/.bin/akm"
  if [[ ! -x "${akm_bin}" ]]; then
    rm -rf "${install_root}"
    mkdir -p "${install_root}"
    npm install --prefix "${install_root}" --no-audit --no-fund "${package_file}"
  fi

  if [[ ! -x "${akm_bin}" ]]; then
    printf 'docker-entrypoint: expected akm binary at %s after package install\n' "${akm_bin}" >&2
    exit 2
  fi

  export AKM_BENCH_AKM_BIN="${akm_bin}"
  export AKM_BENCH_RUNTIME_FINGERPRINT="package:${hash}"
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
    package)
      prepare_package_akm
      ;;
    *)
      printf 'docker-entrypoint: unsupported BENCH_DOCKER_AKM_MODE=%s\n' "${mode}" >&2
      exit 2
      ;;
  esac
}

export TMPDIR="${TMPDIR:-/cache/tmp}"
export BUN_INSTALL_CACHE_DIR="${BUN_INSTALL_CACHE_DIR:-/cache/bun-install-cache}"
mkdir -p /cache "${HOME}" "${TMPDIR}" "${BUN_INSTALL_CACHE_DIR}" "${BENCH_RESULTS_DIR:-/outputs}"
seed_opencode_home
configure_akm_runtime

exec "$@"
