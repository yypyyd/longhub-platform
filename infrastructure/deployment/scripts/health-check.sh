#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: health-check.sh https://LONGHUB_HOST [CA_CERTIFICATE]" >&2
  exit 2
fi
if [[ ${EUID} -ne 0 ]]; then
  echo "health-check.sh must run as root for permission, database and signed Executor probes" >&2
  exit 1
fi

readonly deployment_lock=/run/lock/longhub-deployment.lock
if [[ -e ${deployment_lock} || -L ${deployment_lock} ]]; then
  [[ -f ${deployment_lock} && ! -L ${deployment_lock} &&
    $(stat -c '%u' "${deployment_lock}") == 0 ]] || {
    echo "deployment lock must be a root-owned regular file" >&2
    exit 1
  }
  if find "${deployment_lock}" -perm /077 -print -quit | grep -q .; then
    echo "deployment lock must not be group/world accessible" >&2
    exit 1
  fi
else
  (umask 077; : > "${deployment_lock}")
fi
inherited_lock=$(readlink -f -- "/proc/${BASHPID}/fd/9" 2>/dev/null || true)
if [[ ${inherited_lock} == "${deployment_lock}" ]]; then
  flock -n 9 || { echo "inherited LongHub deployment lock is not held" >&2; exit 1; }
else
  exec 9>"${deployment_lock}"
  flock -n 9 || { echo "another LongHub deployment operation is running" >&2; exit 1; }
fi

readonly BASE_URL=${1%/}
[[ ${BASE_URL} =~ ^https://[A-Za-z0-9.-]+(:([1-9][0-9]{0,4}))?$ ]] || {
  echo "health URL must be an HTTPS origin" >&2
  exit 2
}
health_port=${BASH_REMATCH[2]-}
if [[ -n ${health_port} ]] && (( health_port > 65535 )); then
  echo "health URL contains an invalid port" >&2
  exit 2
fi

curl_args=(--fail --silent --show-error --noproxy '*' --proto '=https' --tlsv1.2 --max-time 10)
if [[ $# -eq 2 ]]; then
  [[ -f $2 && ! -L $2 ]] || { echo "CA certificate must be a regular non-symlink file" >&2; exit 2; }
  curl_args+=(--cacert "$2")
fi

for env_file in \
  /etc/longhub/migrate.env \
  /etc/longhub/cloud-api.env \
  /etc/longhub/executor.env \
  /etc/longhub/site.env; do
  [[ -f ${env_file} && ! -L ${env_file} && $(stat -c '%u' "${env_file}") == 0 ]] || {
    echo "deployment environment file is missing, linked or not root-owned: ${env_file}" >&2
    exit 1
  }
  if find "${env_file}" -perm /077 -print -quit | grep -q .; then
    echo "deployment environment file must have no group/world access: ${env_file}" >&2
    exit 1
  fi
done

systemctl is-active --quiet nginx.service
systemctl is-active --quiet longhub-executor.service
systemctl is-active --quiet longhub-cloud-api.service
[[ $(systemctl show longhub-migrate.service --property=Result --value) == success ]] || {
  echo "migration unit has no successful result" >&2
  exit 1
}

readonly current_release=/opt/longhub/current
resolved_release=$(readlink -f -- "${current_release}" 2>/dev/null || true)
[[ -d ${resolved_release} && ${resolved_release} == /opt/longhub/releases/* ]] || {
  echo "current application release link is invalid" >&2
  exit 1
}
script_path=$(realpath -e -- "${BASH_SOURCE[0]}" 2>/dev/null || true)
installed_script=${resolved_release}/infrastructure/deployment/scripts/health-check.sh
[[ ${script_path} == "${installed_script}" ]] || {
  echo "health check must run from the installed current release" >&2
  exit 1
}
(
  cd "${resolved_release}"
  runuser -u longhub-api -- /bin/bash \
    infrastructure/deployment/scripts/migration-release-gate.sh check
)
resolved_web_release=$(readlink -f -- /var/www/longhub/current 2>/dev/null || true)
[[ -d ${resolved_web_release}/portal && -d ${resolved_web_release}/admin &&
  ${resolved_web_release} == /var/www/longhub/releases/* &&
  ${resolved_web_release##*/} == "${resolved_release##*/}" ]] || {
  echo "application and web releases are not on the same release ID" >&2
  exit 1
}
for service in longhub-executor.service longhub-cloud-api.service; do
  main_pid=$(systemctl show "${service}" --property=MainPID --value)
  [[ ${main_pid} =~ ^[1-9][0-9]*$ && $(readlink -f -- "/proc/${main_pid}/cwd") == "${resolved_release}" ]] || {
    echo "${service} is not running from the current release" >&2
    exit 1
  }
done
migration_started=$(systemctl show longhub-migrate.service --property=ExecMainStartTimestampMonotonic --value)
api_started=$(systemctl show longhub-cloud-api.service --property=ActiveEnterTimestampMonotonic --value)
[[ ${migration_started} =~ ^[1-9][0-9]*$ && ${api_started} =~ ^[1-9][0-9]*$ &&
  ${migration_started} -le ${api_started} ]] || {
  echo "migration did not run before the active Cloud API process" >&2
  exit 1
}

verify_private_skill_tree() {
  local private_dir=$1
  local entry metadata denied_identity special_entry
  [[ -d ${private_dir} && ! -L ${private_dir} ]] || {
    echo "private Skill directory must be a real directory: ${private_dir}" >&2
    return 1
  }
  special_entry=$(find "${private_dir}" ! -type f ! -type d -print -quit)
  [[ -z ${special_entry} ]] || {
    echo "private Skill tree contains a linked or special entry: ${special_entry}" >&2
    return 1
  }
  while IFS= read -r -d '' entry; do
    metadata=$(stat -c '%U:%G:%a' "${entry}")
    [[ ${metadata} == root:longhub-executor:750 ]] || {
      echo "invalid private Skill directory ownership or mode: ${entry} (${metadata})" >&2
      return 1
    }
    if ! runuser -u longhub-executor -- test -r "${entry}" ||
      ! runuser -u longhub-executor -- test -x "${entry}" ||
      runuser -u longhub-executor -- test -w "${entry}"; then
      echo "Executor private Skill directory access is invalid: ${entry}" >&2
      return 1
    fi
    for denied_identity in longhub-api longhub-migrator www-data; do
      if runuser -u "${denied_identity}" -- test -r "${entry}" ||
        runuser -u "${denied_identity}" -- test -w "${entry}" ||
        runuser -u "${denied_identity}" -- test -x "${entry}"; then
        echo "${denied_identity} can access private Skill directory: ${entry}" >&2
        return 1
      fi
    done
  done < <(find "${private_dir}" -type d -print0)
  while IFS= read -r -d '' entry; do
    metadata=$(stat -c '%U:%G:%a' "${entry}")
    [[ ${metadata} == root:longhub-executor:640 ]] || {
      echo "invalid private Skill file ownership or mode: ${entry} (${metadata})" >&2
      return 1
    }
    if ! runuser -u longhub-executor -- test -r "${entry}" ||
      runuser -u longhub-executor -- test -w "${entry}"; then
      echo "Executor private Skill file access is invalid: ${entry}" >&2
      return 1
    fi
    for denied_identity in longhub-api longhub-migrator www-data; do
      if runuser -u "${denied_identity}" -- test -r "${entry}" ||
        runuser -u "${denied_identity}" -- test -w "${entry}"; then
        echo "${denied_identity} can read or modify private Skill file: ${entry}" >&2
        return 1
      fi
    done
  done < <(find "${private_dir}" -type f -print0)
}

for private_dir in \
  "${resolved_release}/apps/longhub-executor/src/private-skills" \
  "${resolved_release}/apps/longhub-executor/dist/private-skills"; do
  verify_private_skill_tree "${private_dir}"
done

health=$(curl "${curl_args[@]}" "${BASE_URL}/v1/health")
readonly node_bin=/opt/longhub/node-v22.22.3-linux-x64/bin/node
printf '%s' "${health}" | "${node_bin}" -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const value = JSON.parse(input);
    if (JSON.stringify(value) !== JSON.stringify({ status: "ok" })) process.exit(1);
  });
'
curl "${curl_args[@]}" --output /dev/null "${BASE_URL}/"
curl "${curl_args[@]}" --output /dev/null "${BASE_URL}/admin/"
"${node_bin}" "${resolved_release}/infrastructure/deployment/scripts/runtime-probe.mjs" "${BASE_URL}"
[[ $(readlink -f -- "${current_release}" 2>/dev/null || true) == "${resolved_release}" &&
  $(readlink -f -- /var/www/longhub/current 2>/dev/null || true) == "${resolved_web_release}" ]] || {
  echo "active release changed during the health check" >&2
  exit 1
}
for service in longhub-executor.service longhub-cloud-api.service; do
  main_pid=$(systemctl show "${service}" --property=MainPID --value)
  [[ ${main_pid} =~ ^[1-9][0-9]*$ && $(readlink -f -- "/proc/${main_pid}/cwd") == "${resolved_release}" ]] || {
    echo "${service} changed release during the health check" >&2
    exit 1
  }
done
printf 'LongHub health check: OK\n'
