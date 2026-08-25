#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "rollback-release.sh must run as root" >&2
  exit 1
fi
if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "usage: rollback-release.sh RELEASE_ID https://LONGHUB_HOST [CA_CERTIFICATE]" >&2
  exit 2
fi

readonly release_id=$1
readonly base_url=$2
readonly ca_certificate=${3-}
[[ ${release_id} =~ ^[0-9]{8}T[0-9]{6}([.-][A-Za-z0-9]+)?$ ]] || {
  echo "invalid release ID" >&2
  exit 2
}
[[ ${base_url} =~ ^https://[A-Za-z0-9.-]+(:([1-9][0-9]{0,4}))?$ ]] || {
  echo "health URL must be an HTTPS origin" >&2
  exit 2
}
health_port=${BASH_REMATCH[2]-}
if [[ -n ${health_port} ]] && (( health_port > 65535 )); then
  echo "health URL contains an invalid port" >&2
  exit 2
fi
if [[ -n ${ca_certificate} ]]; then
  [[ -f ${ca_certificate} && ! -L ${ca_certificate} ]] || {
    echo "CA certificate must be a regular non-symlink file" >&2
    exit 2
  }
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
exec 9>"${deployment_lock}"
flock -n 9 || { echo "another LongHub deployment operation is running" >&2; exit 1; }

readonly release_root=/opt/longhub/releases
readonly web_release_root=/var/www/longhub/releases
readonly current_release=/opt/longhub/current
readonly current_web_release=/var/www/longhub/current
readonly target=${release_root}/${release_id}
readonly web_target=${web_release_root}/${release_id}
readonly nginx_output=/etc/nginx/conf.d/longhub-public.conf
readonly app_next=/opt/longhub/.current-rollback.${BASHPID}
readonly web_next=/var/www/longhub/.current-rollback.${BASHPID}

[[ $(realpath -e -- "${release_root}") == "${release_root}" &&
  $(realpath -e -- "${web_release_root}") == "${web_release_root}" ]] || {
  echo "release roots must be canonical real directories" >&2
  exit 1
}
[[ -d ${target} && ! -L ${target} && $(realpath -e -- "${target}") == "${target}" ]] || {
  echo "application rollback target is invalid" >&2
  exit 1
}
[[ -d ${web_target}/portal && ! -L ${web_target}/portal &&
  -d ${web_target}/admin && ! -L ${web_target}/admin &&
  $(realpath -e -- "${web_target}") == "${web_target}" ]] || {
  echo "web rollback target is invalid" >&2
  exit 1
}

script_path=$(realpath -e -- "${BASH_SOURCE[0]}" 2>/dev/null || true)
initial_release=$(readlink -f -- "${current_release}" 2>/dev/null || true)
initial_web_release=$(readlink -f -- "${current_web_release}" 2>/dev/null || true)
[[ -L ${current_release} && -L ${current_web_release} &&
  -d ${initial_release} && ${initial_release} == "${release_root}/"* &&
  -d ${initial_web_release} && ${initial_web_release} == "${web_release_root}/"* &&
  ${initial_release##*/} == "${initial_web_release##*/}" ]] || {
  echo "current application and web release links are invalid or mismatched" >&2
  exit 1
}
readonly script_dir=${script_path%/*}
[[ ${script_path} == "${initial_release}/infrastructure/deployment/scripts/rollback-release.sh" ]] || {
  echo "rollback must run from the installed current release" >&2
  exit 1
}

unit_names=(longhub-migrate.service longhub-executor.service longhub-cloud-api.service)
required_target_files=(
  apps/longhub-cloud-api/dist/main.js
  apps/longhub-executor/dist/main.js
  infrastructure/deployment/scripts/health-check.sh
  infrastructure/deployment/scripts/migration-release-gate.sh
  infrastructure/deployment/scripts/render-nginx.sh
  infrastructure/deployment/scripts/rollback-release.sh
  infrastructure/deployment/scripts/runtime-probe.mjs
  infrastructure/nginx/longhub-public.conf.template
)
for unit in "${unit_names[@]}"; do
  required_target_files+=("infrastructure/deployment/systemd/${unit}")
done
for relative_path in "${required_target_files[@]}"; do
  asset=${target}/${relative_path}
  [[ -f ${asset} && ! -L ${asset} && $(stat -c '%u' "${asset}") == 0 ]] || {
    echo "rollback target asset is missing, linked or not root-owned: ${relative_path}" >&2
    exit 1
  }
  if find "${asset}" -perm /022 -print -quit | grep -q .; then
    echo "rollback target asset is group/world writable: ${relative_path}" >&2
    exit 1
  fi
done
[[ -f ${script_dir}/render-nginx.sh && ! -L ${script_dir}/render-nginx.sh ]] || {
  echo "installed Nginx renderer is invalid" >&2
  exit 1
}
previous_app_link=$(readlink -- "${current_release}")
previous_web_link=$(readlink -- "${current_web_release}")
api_was_active=false
executor_was_active=false
nginx_was_active=false
systemctl is-active --quiet longhub-cloud-api.service && api_was_active=true
systemctl is-active --quiet longhub-executor.service && executor_was_active=true
systemctl is-active --quiet nginx.service && nginx_was_active=true

declare -A unit_existed=()
for unit in "${unit_names[@]}"; do
  destination=/etc/systemd/system/${unit}
  if [[ -e ${destination} || -L ${destination} ]]; then
    [[ -f ${destination} && ! -L ${destination} ]] || {
      echo "existing systemd unit must be a regular file: ${destination}" >&2
      exit 1
    }
    unit_existed[${unit}]=true
  else
    unit_existed[${unit}]=false
  fi
done

nginx_existed=false
if [[ -e ${nginx_output} || -L ${nginx_output} ]]; then
  [[ -f ${nginx_output} && ! -L ${nginx_output} && $(stat -c '%u' "${nginx_output}") == 0 ]] || {
    echo "existing LongHub Nginx configuration is invalid" >&2
    exit 1
  }
  nginx_existed=true
fi

unit_backup=$(mktemp -d /etc/systemd/system/.longhub-rollback-units.XXXXXX)
chmod 0700 "${unit_backup}"
nginx_backup=
cleanup_prepared_rollback() {
  local status=$?
  rm -rf -- "${unit_backup}"
  [[ -z ${nginx_backup} ]] || rm -f -- "${nginx_backup}"
  return "${status}"
}
trap cleanup_prepared_rollback EXIT
for unit in "${unit_names[@]}"; do
  if [[ ${unit_existed[${unit}]} == true ]]; then
    cp --preserve=mode,ownership -- "/etc/systemd/system/${unit}" "${unit_backup}/${unit}"
  fi
done
if [[ ${nginx_existed} == true ]]; then
  nginx_backup=$(mktemp /etc/nginx/conf.d/.longhub-rollback-nginx.XXXXXX)
  cp --preserve=mode,ownership -- "${nginx_output}" "${nginx_backup}"
  chown root:root "${nginx_backup}"
  chmod 0600 "${nginx_backup}"
fi

units_installed=false
app_swapped=false
web_swapped=false
target_migration_may_have_run=false
restore_link() {
  local link=$1
  local previous=$2
  local restore=${link}.restore.${BASHPID}
  ln -s -- "${previous}" "${restore}"
  mv -Tf -- "${restore}" "${link}"
}
stop_nginx_fail_closed() {
  local state
  systemctl stop nginx.service >/dev/null 2>&1 || true
  state=$(systemctl is-active nginx.service 2>/dev/null || true)
  case ${state} in
    inactive|failed) return 0 ;;
  esac
  systemctl kill --kill-who=all --signal=SIGKILL nginx.service >/dev/null 2>&1 || true
  systemctl stop nginx.service >/dev/null 2>&1 || true
  state=$(systemctl is-active nginx.service 2>/dev/null || true)
  [[ ${state} == inactive || ${state} == failed ]]
}
cleanup_failed_rollback() {
  local status=$?
  local recovery_failed=false
  local application_services_stopped=true
  local next_unit nginx_restore_next service state
  set +e
  if ! systemctl stop longhub-cloud-api.service longhub-executor.service \
    longhub-migrate.service >/dev/null 2>&1; then
    echo "rollback recovery could not stop all application services" >&2
    recovery_failed=true
    systemctl kill --kill-who=all --signal=SIGKILL \
      longhub-cloud-api.service longhub-executor.service longhub-migrate.service >/dev/null 2>&1 || true
    systemctl stop longhub-cloud-api.service longhub-executor.service \
      longhub-migrate.service >/dev/null 2>&1 || true
  fi
  for service in longhub-cloud-api.service longhub-executor.service longhub-migrate.service; do
    state=$(systemctl is-active "${service}" 2>/dev/null || true)
    case ${state} in
      inactive|failed) ;;
      *)
        echo "rollback recovery found ${service} still in state ${state:-unknown}" >&2
        application_services_stopped=false
        recovery_failed=true
        ;;
    esac
  done
  if [[ ${application_services_stopped} == false ]] && ! stop_nginx_fail_closed; then
    echo "critical: Nginx could not be stopped while target application processes remain" >&2
    recovery_failed=true
  fi
  if [[ ${app_swapped} == true ]] && ! restore_link "${current_release}" "${previous_app_link}"; then
    echo "rollback recovery could not restore the application link" >&2
    recovery_failed=true
  fi
  if [[ ${web_swapped} == true ]] && ! restore_link "${current_web_release}" "${previous_web_link}"; then
    echo "rollback recovery could not restore the web link" >&2
    recovery_failed=true
  fi
  rm -f -- "${app_next}" "${web_next}" || recovery_failed=true
  if [[ ${units_installed} == true ]]; then
    for unit in "${unit_names[@]}"; do
      next_unit=/etc/systemd/system/.${unit}.restore.${BASHPID}
      rm -f -- "/etc/systemd/system/.${unit}.rollback.${BASHPID}" "${next_unit}"
      if [[ ${unit_existed[${unit}]} == true ]]; then
        if ! cp --preserve=mode,ownership -- "${unit_backup}/${unit}" "${next_unit}" ||
          ! mv -Tf -- "${next_unit}" "/etc/systemd/system/${unit}"; then
          echo "rollback recovery could not restore ${unit}" >&2
          recovery_failed=true
        fi
      else
        if ! rm -f -- "/etc/systemd/system/${unit}"; then
          echo "rollback recovery could not remove newly installed ${unit}" >&2
          recovery_failed=true
        fi
      fi
    done
    if ! systemctl daemon-reload >/dev/null 2>&1; then
      echo "rollback recovery could not reload restored systemd units" >&2
      recovery_failed=true
    fi
  fi
  if [[ ${nginx_existed} == true && -f ${nginx_backup} ]]; then
    nginx_restore_next=/etc/nginx/conf.d/.longhub-public.restore.${BASHPID}
    rm -f -- "${nginx_restore_next}"
    if ! install -o root -g root -m 0644 "${nginx_backup}" "${nginx_restore_next}" ||
      ! mv -Tf -- "${nginx_restore_next}" "${nginx_output}"; then
      echo "rollback recovery could not restore the Nginx configuration" >&2
      recovery_failed=true
    fi
  elif [[ ${nginx_existed} == false ]]; then
    if ! rm -f -- "${nginx_output}"; then
      echo "rollback recovery could not remove the new Nginx configuration" >&2
      recovery_failed=true
    fi
  else
    echo "rollback recovery Nginx backup is missing" >&2
    recovery_failed=true
  fi
  if [[ ${recovery_failed} == true ]]; then
    if ! stop_nginx_fail_closed; then
      echo "critical: Nginx could not be left stopped after incomplete recovery" >&2
      recovery_failed=true
    fi
  elif [[ ${nginx_was_active} == true ]]; then
    if ! nginx -t >/dev/null 2>&1 || ! systemctl restart nginx.service >/dev/null 2>&1; then
      echo "rollback recovery could not validate or restart Nginx" >&2
      recovery_failed=true
    fi
  else
    if ! systemctl stop nginx.service >/dev/null 2>&1; then
      echo "rollback recovery could not restore the stopped Nginx state" >&2
      recovery_failed=true
    fi
  fi
  if [[ ${recovery_failed} == true ]] && ! stop_nginx_fail_closed; then
    echo "critical: Nginx remains active after incomplete recovery" >&2
  fi
  if [[ ${target_migration_may_have_run} == true ]]; then
    echo "target migration may have committed; previous application services remain stopped" >&2
    echo "restore the release-matched database backup before starting the previous Cloud API" >&2
  elif [[ ${recovery_failed} == false && ${api_was_active} == true ]]; then
    if ! systemctl start longhub-cloud-api.service >/dev/null 2>&1; then
      echo "rollback recovery could not restart the previous Cloud API" >&2
      recovery_failed=true
    fi
  elif [[ ${recovery_failed} == false && ${executor_was_active} == true ]]; then
    if ! systemctl start longhub-executor.service >/dev/null 2>&1; then
      echo "rollback recovery could not restart the previous Executor" >&2
      recovery_failed=true
    fi
  fi
  if [[ ${recovery_failed} == true ]] && ! stop_nginx_fail_closed; then
    echo "critical: Nginx remains active after failed previous-service startup" >&2
  fi
  if [[ ${target_migration_may_have_run} == false && ${recovery_failed} == true ]]; then
    echo "previous application services remain stopped after incomplete recovery" >&2
  fi
  if [[ ${recovery_failed} == false ]]; then
    rm -rf -- "${unit_backup}"
    [[ -z ${nginx_backup} ]] || rm -f -- "${nginx_backup}"
  else
    echo "rollback recovery was incomplete; preserved unit backup: ${unit_backup}" >&2
    [[ -z ${nginx_backup} ]] || echo "preserved Nginx backup: ${nginx_backup}" >&2
  fi
  return "${status}"
}
trap - EXIT
trap cleanup_failed_rollback EXIT

systemctl stop longhub-cloud-api.service longhub-executor.service longhub-migrate.service
units_installed=true
for unit in "${unit_names[@]}"; do
  next_unit=/etc/systemd/system/.${unit}.rollback.${BASHPID}
  install -o root -g root -m 0644 \
    "${target}/infrastructure/deployment/systemd/${unit}" "${next_unit}"
  mv -Tf -- "${next_unit}" "/etc/systemd/system/${unit}"
done

[[ ! -e ${app_next} && ! -L ${app_next} && ! -e ${web_next} && ! -L ${web_next} ]] || {
  echo "temporary rollback link already exists" >&2
  exit 1
}
ln -s "releases/${release_id}" "${app_next}"
ln -s "releases/${release_id}" "${web_next}"
web_swapped=true
mv -Tf -- "${web_next}" "${current_web_release}"
app_swapped=true
mv -Tf -- "${app_next}" "${current_release}"
systemctl daemon-reload

/bin/bash "${script_dir}/render-nginx.sh" --deployment-lock-held
systemctl reset-failed longhub-migrate.service longhub-executor.service longhub-cloud-api.service
target_migration_may_have_run=true
systemctl start nginx.service longhub-cloud-api.service

health_args=("${base_url}")
[[ -z ${ca_certificate} ]] || health_args+=("${ca_certificate}")
/bin/bash "${target}/infrastructure/deployment/scripts/health-check.sh" "${health_args[@]}"

trap - EXIT
rm -rf -- "${unit_backup}"
[[ -z ${nginx_backup} ]] || rm -f -- "${nginx_backup}"
printf 'Rolled back LongHub application and web release to: %s\n' "${release_id}"
