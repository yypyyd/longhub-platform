#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: migration-release-gate.sh run|check|exec-api|exec-executor" >&2
  exit 2
fi
case ${1} in
  run|check|exec-api|exec-executor) ;;
  *)
    echo "usage: migration-release-gate.sh run|check|exec-api|exec-executor" >&2
    exit 2
    ;;
esac

readonly mode=$1
readonly current_release=/opt/longhub/current
readonly release_root=/opt/longhub/releases
readonly marker_dir=/run/longhub-migrate
readonly marker_file=${marker_dir}/release
readonly node_bin=/opt/longhub/node-v22.22.3-linux-x64/bin/node

resolved_release=$(readlink -f -- "${current_release}" 2>/dev/null || true)
[[ -d ${resolved_release} && ${resolved_release} == "${release_root}/"* ]] || {
  echo "current application release is invalid" >&2
  exit 1
}
working_release=$(pwd -P)
[[ ${working_release} == "${resolved_release}" ]] || {
  echo "migration gate is not running from the current release" >&2
  exit 1
}
script_path=$(realpath -e -- "${BASH_SOURCE[0]}" 2>/dev/null || true)
expected_script=${resolved_release}/infrastructure/deployment/scripts/migration-release-gate.sh
[[ ${script_path} == "${expected_script}" ]] || {
  echo "migration gate script is not from the current release" >&2
  exit 1
}

if [[ ${mode} == run ]]; then
  [[ ${EUID} -eq $(id -u longhub-migrator) ]] || {
    echo "migration release gate must run as longhub-migrator" >&2
    exit 1
  }
  [[ -d ${marker_dir} && ! -L ${marker_dir} &&
    $(realpath -e -- "${marker_dir}") == "${marker_dir}" &&
    $(stat -c '%U:%G:%a' "${marker_dir}") == longhub-migrator:longhub-migrator:755 ]] || {
    echo "migration marker directory has invalid ownership or mode" >&2
    exit 1
  }
  "${node_bin}" "${working_release}/apps/longhub-cloud-api/scripts/migrate.mjs"
  marker_tmp=$(mktemp "${marker_dir}/.release.XXXXXX")
  cleanup_marker() {
    rm -f -- "${marker_tmp}"
  }
  trap cleanup_marker EXIT
  printf '%s\n' "${working_release}" > "${marker_tmp}"
  chmod 0644 "${marker_tmp}"
  mv -Tf -- "${marker_tmp}" "${marker_file}"
  trap - EXIT
  [[ $(readlink -f -- "${current_release}" 2>/dev/null || true) == "${working_release}" ]] || {
    echo "current release changed while its migration was running" >&2
    exit 1
  }
  printf 'Recorded migrated LongHub release: %s\n' "${working_release}"
  exit 0
fi

[[ -f ${marker_file} && ! -L ${marker_file} &&
  $(stat -c '%u' "${marker_file}") == $(id -u longhub-migrator) ]] || {
  echo "successful migration marker is missing or invalid" >&2
  exit 1
}
if find "${marker_file}" -perm /022 -print -quit | grep -q .; then
  echo "successful migration marker must not be group/world writable" >&2
  exit 1
fi
mapfile -t marker_lines < "${marker_file}"
[[ ${#marker_lines[@]} -eq 1 && ${marker_lines[0]} == "${resolved_release}" ]] || {
  echo "current release has not completed its migration gate" >&2
  exit 1
}

case ${mode} in
  check)
    exit 0
    ;;
  exec-api)
    [[ ${EUID} -eq $(id -u longhub-api) ]] || {
      echo "Cloud API release gate must run as longhub-api" >&2
      exit 1
    }
    exec "${node_bin}" "${working_release}/apps/longhub-cloud-api/dist/main.js"
    ;;
  exec-executor)
    [[ ${EUID} -eq $(id -u longhub-executor) ]] || {
      echo "Executor release gate must run as longhub-executor" >&2
      exit 1
    }
    exec "${node_bin}" "${working_release}/apps/longhub-executor/dist/main.js"
    ;;
esac
