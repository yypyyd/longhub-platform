#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "install-release.sh must run as root" >&2
  exit 1
fi
if [[ $# -ne 2 ]]; then
  echo "usage: install-release.sh BUILT_SOURCE RELEASE_ID" >&2
  exit 2
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
readonly web_root=/var/www/longhub
readonly web_release_root=${web_root}/releases
source_dir=$(realpath -e -- "$1" 2>/dev/null) || {
  echo "invalid built source" >&2
  exit 2
}
release_id=$2
[[ -d ${source_dir} && ${release_id} =~ ^[0-9]{8}T[0-9]{6}([.-][A-Za-z0-9]+)?$ ]] || {
  echo "invalid built source or release ID" >&2
  exit 2
}
case "${source_dir}/" in
  /opt/longhub/*|/var/www/longhub/*)
    echo "built source must be outside deployment release roots" >&2
    exit 2
    ;;
esac
special_source_entry=$(find "${source_dir}" \
  ! -type f ! -type d ! -type l -print -quit)
[[ -z ${special_source_entry} ]] || {
  echo "built source contains a special filesystem entry: ${special_source_entry}" >&2
  exit 1
}

required_files=(
  apps/longhub-cloud-api/dist/main.js
  apps/longhub-executor/dist/main.js
  apps/longhub-executor/dist/private-skills/registry.js
  apps/longhub-executor/src/private-skills/registry.ts
  apps/longhub-portal/dist/index.html
  apps/longhub-admin-web/dist/index.html
  infrastructure/deployment/scripts/health-check.sh
  infrastructure/deployment/scripts/migration-release-gate.sh
  infrastructure/deployment/scripts/render-nginx.sh
  infrastructure/deployment/scripts/rollback-release.sh
  infrastructure/deployment/scripts/runtime-probe.mjs
  infrastructure/nginx/longhub-public.conf.template
)
for required in "${required_files[@]}"; do
  [[ -f ${source_dir}/${required} && ! -L ${source_dir}/${required} ]] || {
    echo "built source is missing regular file ${required}" >&2
    exit 1
  }
done

private_source_dirs=(
  "${source_dir}/apps/longhub-executor/src/private-skills"
  "${source_dir}/apps/longhub-executor/dist/private-skills"
)
for private_dir in "${private_source_dirs[@]}"; do
  [[ -d ${private_dir} && ! -L ${private_dir} ]] || {
    echo "private Skill directory must be a real directory: ${private_dir}" >&2
    exit 1
  }
  [[ -z $(find "${private_dir}" -type l -print -quit) ]] || {
    echo "private Skill directories must not contain symlinks: ${private_dir}" >&2
    exit 1
  }
done
for static_dir in \
  "${source_dir}/apps/longhub-portal/dist" \
  "${source_dir}/apps/longhub-admin-web/dist"; do
  [[ -d ${static_dir} && ! -L ${static_dir} && -z $(find "${static_dir}" -type l -print -quit) ]] || {
    echo "static site directory is missing or contains symlinks: ${static_dir}" >&2
    exit 1
  }
done

for base in \
  /opt/longhub "${release_root}" \
  /etc/longhub /etc/longhub/tls /etc/longhub/keys \
  /var/lib/longhub /var/lib/longhub/client-releases \
  /var/lib/longhub/cloud-plugin-releases /var/lib/longhub/cloud-cli-releases \
  "${web_root}" "${web_release_root}"; do
  [[ ! -L ${base} ]] || { echo "deployment base must not be a symlink: ${base}" >&2; exit 1; }
done
install -d -o root -g root -m 0755 /opt/longhub "${release_root}"
install -d -o root -g root -m 0700 /etc/longhub /etc/longhub/tls /etc/longhub/keys
install -d -o root -g root -m 0755 "${web_root}" "${web_release_root}"

getent group longhub-runtime >/dev/null || groupadd --system longhub-runtime
for identity in longhub-api longhub-executor longhub-migrator; do
  getent group "${identity}" >/dev/null || groupadd --system "${identity}"
  if ! id -u "${identity}" >/dev/null 2>&1; then
    useradd --system --gid "${identity}" --groups longhub-runtime \
      --home-dir /nonexistent --shell /usr/sbin/nologin "${identity}"
  else
    passwd_entry=$(getent passwd "${identity}")
    IFS=: read -r _ _ _ primary_gid _ home shell <<< "${passwd_entry}"
    expected_gid=$(getent group "${identity}" | cut -d: -f3)
    [[ ${primary_gid} == "${expected_gid}" && ${home} == /nonexistent && ${shell} == /usr/sbin/nologin ]] || {
      echo "existing ${identity} account does not match the service identity contract" >&2
      exit 1
    }
    usermod --append --groups longhub-runtime "${identity}"
  fi
done
[[ -z $(getent group longhub-executor | cut -d: -f4) ]] || {
  echo "longhub-executor group must not contain supplemental members" >&2
  exit 1
}
executor_gid=$(getent group longhub-executor | cut -d: -f3)
unexpected_executor_primary=$(getent passwd | awk -F: -v gid="${executor_gid}" \
  '$4 == gid && $1 != "longhub-executor" { print $1; exit }')
[[ -z ${unexpected_executor_primary} ]] || {
  echo "unexpected account uses the longhub-executor primary group: ${unexpected_executor_primary}" >&2
  exit 1
}
id -u www-data >/dev/null 2>&1 || { echo "missing nginx www-data identity" >&2; exit 1; }

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

readonly target=${release_root}/${release_id}
readonly web_target=${web_release_root}/${release_id}
created_release=false
created_web_release=false
web_swapped=false
app_swapped=false
previous_web_link=
previous_app_link=
had_previous_web=false
had_previous_app=false
readonly app_next=/opt/longhub/.current-next.${BASHPID}
readonly web_next=${web_root}/.current-next.${BASHPID}
unit_backup=
units_installed=false
unit_names=(longhub-migrate.service longhub-executor.service longhub-cloud-api.service)
declare -A unit_existed=()

restore_link() {
  local link=$1
  local previous=$2
  local had_previous=$3
  local rollback=${link}.rollback.${BASHPID}
  if [[ ${had_previous} == true ]]; then
    ln -s -- "${previous}" "${rollback}" && mv -Tf -- "${rollback}" "${link}"
  elif [[ -L ${link} ]]; then
    rm -f -- "${link}"
  fi
}

cleanup_failed_install() {
  local status=$?
  set +e
  if [[ ${app_swapped} == true ]]; then
    restore_link /opt/longhub/current "${previous_app_link}" "${had_previous_app}"
  fi
  if [[ ${web_swapped} == true ]]; then
    restore_link "${web_root}/current" "${previous_web_link}" "${had_previous_web}"
  fi
  [[ ! -L ${app_next} ]] || rm -f -- "${app_next}"
  [[ ! -L ${web_next} ]] || rm -f -- "${web_next}"
  if [[ ${units_installed} == true ]]; then
    for unit in "${unit_names[@]}"; do
      rm -f -- "/etc/systemd/system/.${unit}.next.${BASHPID}"
      if [[ ${unit_existed[${unit}]-false} == true ]]; then
        mv -Tf -- "${unit_backup}/${unit}" "/etc/systemd/system/${unit}"
      else
        rm -f -- "/etc/systemd/system/${unit}"
      fi
    done
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  [[ -z ${unit_backup} || ! -d ${unit_backup} ]] || rm -rf -- "${unit_backup}"
  active_application=$(readlink -f -- /opt/longhub/current 2>/dev/null || true)
  active_web=$(readlink -f -- "${web_root}/current" 2>/dev/null || true)
  if [[ ${created_release} == true && -d ${target} && ! -L ${target} && ${active_application} != "${target}" ]]; then
    rm -rf -- "${target}"
  fi
  if [[ ${created_web_release} == true && -d ${web_target} && ! -L ${web_target} && ${active_web} != "${web_target}" ]]; then
    rm -rf -- "${web_target}"
  fi
  return "${status}"
}
trap cleanup_failed_install EXIT

rsync_compare=(
  rsync -rlcni --delete --delete-excluded
  --exclude=.git --exclude=.turbo --exclude=.env --exclude=.env.* --exclude=.npmrc
  --out-format=%i:%n%L
)
if [[ -e ${target} || -L ${target} ]]; then
  [[ -d ${target} && ! -L ${target} ]] || { echo "invalid existing release: ${target}" >&2; exit 1; }
  differences=$("${rsync_compare[@]}" "${source_dir}/" "${target}/")
  [[ -z ${differences} ]] || {
    echo "release ID already exists with different content: ${target}" >&2
    exit 1
  }
else
  install -d -o root -g root -m 0700 "${target}"
  created_release=true
  rsync -a --delete --delete-excluded \
    --exclude=.git --exclude=.turbo --exclude=.env --exclude=.env.* --exclude=.npmrc \
    "${source_dir}/" "${target}/"
fi

# Keep the release root private until every Skill path has its final owner.
chown -R root:longhub-runtime "${target}"
find "${target}" -mindepth 1 -type d -exec chmod 0750 {} +
find "${target}" -mindepth 1 -type f -exec chmod 0640 {} +
private_release_dirs=(
  "${target}/apps/longhub-executor/src/private-skills"
  "${target}/apps/longhub-executor/dist/private-skills"
)
for private_dir in "${private_release_dirs[@]}"; do
  [[ -d ${private_dir} && ! -L ${private_dir} && -z $(find "${private_dir}" -type l -print -quit) ]] || {
    echo "installed private Skill directory is invalid: ${private_dir}" >&2
    exit 1
  }
  chown -R root:longhub-executor "${private_dir}"
  find "${private_dir}" -type d -exec chmod 0750 {} +
  find "${private_dir}" -type f -exec chmod 0640 {} +
done
chown root:longhub-runtime "${target}"
chmod 0750 "${target}"

for private_dir in "${private_release_dirs[@]}"; do
  verify_private_skill_tree "${private_dir}"
done

if [[ -e ${web_target} || -L ${web_target} ]]; then
  [[ -d ${web_target} && ! -L ${web_target} ]] || { echo "invalid existing web release" >&2; exit 1; }
  portal_differences=$(rsync -rlcni --delete --out-format=%i:%n%L \
    "${source_dir}/apps/longhub-portal/dist/" "${web_target}/portal/")
  admin_differences=$(rsync -rlcni --delete --out-format=%i:%n%L \
    "${source_dir}/apps/longhub-admin-web/dist/" "${web_target}/admin/")
  web_entries=$(find "${web_target}" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort)
  [[ -z ${portal_differences} && -z ${admin_differences} && ${web_entries} == $'admin\nportal' ]] || {
    echo "web release ID already exists with different content" >&2
    exit 1
  }
else
  install -d -o root -g root -m 0700 "${web_target}"
  created_web_release=true
  install -d -o root -g root -m 0700 "${web_target}/portal" "${web_target}/admin"
  rsync -a --delete "${source_dir}/apps/longhub-portal/dist/" "${web_target}/portal/"
  rsync -a --delete "${source_dir}/apps/longhub-admin-web/dist/" "${web_target}/admin/"
fi
chown -R root:root "${web_target}"
find "${web_target}" -mindepth 1 -type d -exec chmod 0755 {} +
find "${web_target}" -mindepth 1 -type f -exec chmod 0644 {} +
chmod 0755 "${web_target}"

install -d -o root -g root -m 0755 /var/lib/longhub
install -d -o longhub-api -g www-data -m 2750 /var/lib/longhub/client-releases
install -d -o longhub-api -g www-data -m 2750 /var/lib/longhub/cloud-plugin-releases
install -d -o longhub-api -g www-data -m 2750 /var/lib/longhub/cloud-cli-releases
unit_backup=$(mktemp -d /etc/systemd/system/.longhub-unit-backup.XXXXXX)
chmod 0700 "${unit_backup}"
for unit in "${unit_names[@]}"; do
  source_unit=${target}/infrastructure/deployment/systemd/${unit}
  destination_unit=/etc/systemd/system/${unit}
  [[ -f ${source_unit} && ! -L ${source_unit} ]] || { echo "missing systemd unit ${unit}" >&2; exit 1; }
  if [[ -e ${destination_unit} || -L ${destination_unit} ]]; then
    [[ -f ${destination_unit} && ! -L ${destination_unit} ]] || {
      echo "existing systemd unit must be a regular file: ${destination_unit}" >&2
      exit 1
    }
    cp --preserve=mode,ownership -- "${destination_unit}" "${unit_backup}/${unit}"
    unit_existed[${unit}]=true
  else
    unit_existed[${unit}]=false
  fi
done
units_installed=true
for unit in "${unit_names[@]}"; do
  source_unit=${target}/infrastructure/deployment/systemd/${unit}
  destination_unit=/etc/systemd/system/${unit}
  next_unit=/etc/systemd/system/.${unit}.next.${BASHPID}
  install -o root -g root -m 0644 "${source_unit}" "${next_unit}"
  mv -Tf -- "${next_unit}" "${destination_unit}"
done
systemctl daemon-reload

for link in /opt/longhub/current "${web_root}/current"; do
  [[ ! -e ${link} || -L ${link} ]] || { echo "activation path is not a symlink: ${link}" >&2; exit 1; }
done
if [[ -L /opt/longhub/current ]]; then
  previous_app_link=$(readlink -- /opt/longhub/current)
  had_previous_app=true
  previous_app_target=$(readlink -f -- /opt/longhub/current 2>/dev/null || true)
  [[ -d ${previous_app_target} && ${previous_app_target} == "${release_root}/"* ]] || {
    echo "current application link is dangling or escapes release root" >&2
    exit 1
  }
fi
if [[ -L ${web_root}/current ]]; then
  previous_web_link=$(readlink -- "${web_root}/current")
  had_previous_web=true
  previous_web_target=$(readlink -f -- "${web_root}/current" 2>/dev/null || true)
  [[ -d ${previous_web_target} && ${previous_web_target} == "${web_release_root}/"* ]] || {
    echo "current web link is dangling or escapes release root" >&2
    exit 1
  }
fi
[[ ! -e ${app_next} && ! -L ${app_next} && ! -e ${web_next} && ! -L ${web_next} ]] || {
  echo "temporary activation link already exists" >&2
  exit 1
}
ln -s "releases/${release_id}" "${app_next}"
ln -s "releases/${release_id}" "${web_next}"
web_swapped=true
mv -Tf -- "${web_next}" "${web_root}/current"
app_swapped=true
mv -Tf -- "${app_next}" /opt/longhub/current

trap - EXIT
rm -rf -- "${unit_backup}" || echo "warning: could not remove ${unit_backup}" >&2
unit_backup=
units_installed=false
printf 'Installed LongHub release: %s\n' "$(readlink -f -- /opt/longhub/current)"
printf 'Installed LongHub web release: %s\n' "$(readlink -f -- "${web_root}/current")"
