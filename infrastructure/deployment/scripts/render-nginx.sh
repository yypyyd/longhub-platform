#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "render-nginx.sh must run as root" >&2
  exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && ${1-} != --deployment-lock-held ) ]]; then
  echo "usage: render-nginx.sh [--deployment-lock-held]" >&2
  exit 2
fi

readonly deployment_lock=/run/lock/longhub-deployment.lock
if [[ $# -eq 1 ]]; then
  inherited_lock=$(readlink -f -- "/proc/${BASHPID}/fd/9" 2>/dev/null || true)
  [[ ${inherited_lock} == "${deployment_lock}" ]] || {
    echo "--deployment-lock-held requires inherited deployment lock fd 9" >&2
    exit 1
  }
  flock -n 9 || { echo "inherited LongHub deployment lock is not held" >&2; exit 1; }
else
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
fi

readonly ENV_FILE=/etc/longhub/site.env
readonly TEMPLATE=/opt/longhub/current/infrastructure/nginx/longhub-public.conf.template
readonly OUTPUT=/etc/nginx/conf.d/longhub-public.conf
NGINX_SUBSTITUTIONS='${LONGHUB_SERVER_NAME} ${LONGHUB_TLS_CERTIFICATE} ${LONGHUB_TLS_CERTIFICATE_KEY} '
NGINX_SUBSTITUTIONS+='${LONGHUB_CLIENT_RELEASE_DIR} ${LONGHUB_CLOUD_PLUGIN_RELEASE_DIR} '
NGINX_SUBSTITUTIONS+='${LONGHUB_CLOUD_CLI_RELEASE_DIR} ${LONGHUB_CLOUD_API_UPSTREAM} ${LONGHUB_WEB_ROOT}'
readonly NGINX_SUBSTITUTIONS
readonly REQUIRED_CSP_HEADER="  add_header Content-Security-Policy \"default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'\" always;"
readonly REQUIRED_FRAME_HEADER='  add_header X-Frame-Options "DENY" always;'
required=(
  LONGHUB_SERVER_NAME LONGHUB_TLS_CERTIFICATE LONGHUB_TLS_CERTIFICATE_KEY
  LONGHUB_CLIENT_RELEASE_DIR LONGHUB_CLOUD_PLUGIN_RELEASE_DIR LONGHUB_CLOUD_CLI_RELEASE_DIR
  LONGHUB_CLOUD_API_UPSTREAM LONGHUB_WEB_ROOT
)

[[ -f ${ENV_FILE} && ! -L ${ENV_FILE} ]] || { echo "missing regular ${ENV_FILE}" >&2; exit 1; }
[[ $(stat -c '%u' "${ENV_FILE}") == 0 ]] || { echo "${ENV_FILE} must be root-owned" >&2; exit 1; }
if find "${ENV_FILE}" -perm /077 -print -quit | grep -q .; then
  echo "${ENV_FILE} must not be group/world accessible" >&2
  exit 1
fi
[[ -f ${TEMPLATE} && ! -L ${TEMPLATE} ]] || { echo "missing deployment Nginx template" >&2; exit 1; }
[[ $(stat -c '%u' "${TEMPLATE}") == 0 ]] || { echo "deployment Nginx template must be root-owned" >&2; exit 1; }
if find "${TEMPLATE}" -perm /022 -print -quit | grep -q .; then
  echo "deployment Nginx template must not be group/world writable" >&2
  exit 1
fi

# site.env deliberately accepts only plain KEY=value records. Never execute a
# deployment environment file as shell code from this root process.
declare -A values=()
line_number=0
while IFS= read -r line || [[ -n ${line} ]]; do
  ((line_number += 1))
  line=${line%$'\r'}
  [[ ${line} =~ ^[[:space:]]*$ || ${line} =~ ^[[:space:]]*# ]] && continue
  [[ ${line} =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]#]+)$ ]] || {
    echo "invalid plain KEY=value record in ${ENV_FILE}:${line_number}" >&2
    exit 1
  }
  name=${BASH_REMATCH[1]}
  value=${BASH_REMATCH[2]}
  case " ${required[*]} " in
    *" ${name} "*) ;;
    *) echo "unexpected setting ${name} in ${ENV_FILE}" >&2; exit 1 ;;
  esac
  [[ -z ${values[${name}]+present} ]] || {
    echo "duplicate setting ${name} in ${ENV_FILE}" >&2
    exit 1
  }
  values[${name}]=${value}
done < "${ENV_FILE}"

for name in "${required[@]}"; do
  [[ -n ${values[${name}]-} ]] || { echo "missing ${name}" >&2; exit 1; }
  printf -v "${name}" '%s' "${values[${name}]}"
  export "${name}"
done

[[ ${#LONGHUB_SERVER_NAME} -le 253 && ${LONGHUB_SERVER_NAME} != .* &&
  ${LONGHUB_SERVER_NAME} != *. && ${LONGHUB_SERVER_NAME} != *..* &&
  ${LONGHUB_SERVER_NAME} =~ ^[A-Za-z0-9.-]+$ ]] || {
  echo "invalid LONGHUB_SERVER_NAME" >&2
  exit 1
}
IFS=. read -r -a server_labels <<< "${LONGHUB_SERVER_NAME}"
for label in "${server_labels[@]}"; do
  [[ ${#label} -ge 1 && ${#label} -le 63 && ${label} =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || {
    echo "invalid LONGHUB_SERVER_NAME label" >&2
    exit 1
  }
done
[[ ${LONGHUB_CLOUD_API_UPSTREAM} =~ ^127\.0\.0\.1:([1-9][0-9]{0,4})$ ]] || {
  echo "Cloud API upstream must be loopback" >&2
  exit 1
}
(( BASH_REMATCH[1] <= 65535 )) || { echo "invalid Cloud API upstream port" >&2; exit 1; }
for name in LONGHUB_TLS_CERTIFICATE LONGHUB_TLS_CERTIFICATE_KEY LONGHUB_CLIENT_RELEASE_DIR \
  LONGHUB_CLOUD_PLUGIN_RELEASE_DIR LONGHUB_CLOUD_CLI_RELEASE_DIR LONGHUB_WEB_ROOT; do
  [[ ${!name} =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "invalid absolute path in ${name}" >&2; exit 1; }
done

[[ -f ${LONGHUB_TLS_CERTIFICATE} && ! -L ${LONGHUB_TLS_CERTIFICATE} ]] || {
  echo "TLS certificate must be a regular non-symlink file" >&2
  exit 1
}
[[ -f ${LONGHUB_TLS_CERTIFICATE_KEY} && ! -L ${LONGHUB_TLS_CERTIFICATE_KEY} ]] || {
  echo "TLS private key must be a regular non-symlink file" >&2
  exit 1
}
for name in LONGHUB_TLS_CERTIFICATE LONGHUB_TLS_CERTIFICATE_KEY; do
  canonical=$(realpath -e -- "${!name}")
  [[ ${canonical} == "${!name}" ]] || { echo "${name} must not traverse symlinks" >&2; exit 1; }
done
readonly TLS_DIRECTORY=/etc/longhub/tls
[[ -d ${TLS_DIRECTORY} && ! -L ${TLS_DIRECTORY} && $(stat -c '%u' "${TLS_DIRECTORY}") == 0 ]] || {
  echo "TLS directory must be a root-owned real directory" >&2
  exit 1
}
if find "${TLS_DIRECTORY}" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
  echo "TLS directory must not be group/world writable" >&2
  exit 1
fi
for name in LONGHUB_TLS_CERTIFICATE LONGHUB_TLS_CERTIFICATE_KEY; do
  [[ ${!name} == "${TLS_DIRECTORY}/"* ]] || { echo "${name} must be stored below ${TLS_DIRECTORY}" >&2; exit 1; }
done
[[ $(stat -c '%u' "${LONGHUB_TLS_CERTIFICATE}") == 0 && $(stat -c '%u' "${LONGHUB_TLS_CERTIFICATE_KEY}") == 0 ]] || {
  echo "TLS certificate and private key must be root-owned" >&2
  exit 1
}
if find "${LONGHUB_TLS_CERTIFICATE}" -perm /022 -print -quit | grep -q .; then
  echo "TLS certificate must not be group/world writable" >&2
  exit 1
fi
if find "${LONGHUB_TLS_CERTIFICATE_KEY}" -perm /077 -print -quit | grep -q .; then
  echo "TLS private key must not be group/world accessible" >&2
  exit 1
fi

[[ -d ${LONGHUB_CLIENT_RELEASE_DIR} && ! -L ${LONGHUB_CLIENT_RELEASE_DIR} ]] || {
  echo "client release directory must be a real directory" >&2
  exit 1
}
for name in LONGHUB_CLOUD_PLUGIN_RELEASE_DIR LONGHUB_CLOUD_CLI_RELEASE_DIR; do
  [[ -d ${!name} && ! -L ${!name} ]] || { echo "${name} must be a real directory" >&2; exit 1; }
  [[ $(realpath -e -- "${!name}") == "${!name}" ]] || { echo "${name} must not traverse symlinks" >&2; exit 1; }
  [[ $(stat -c '%U:%G' "${!name}") == longhub-api:www-data ]] || {
    echo "${name} must be owned by longhub-api:www-data" >&2
    exit 1
  }
  if find "${!name}" -maxdepth 0 -perm /027 -print -quit | grep -q .; then
    echo "${name} must not be group-writable or world-accessible" >&2
    exit 1
  fi
done
[[ $(realpath -e -- "${LONGHUB_CLIENT_RELEASE_DIR}") == "${LONGHUB_CLIENT_RELEASE_DIR}" ]] || {
  echo "client release directory must not traverse symlinks" >&2
  exit 1
}
[[ $(stat -c '%U:%G' "${LONGHUB_CLIENT_RELEASE_DIR}") == longhub-api:www-data ]] || {
  echo "client release directory must be owned by longhub-api:www-data" >&2
  exit 1
}
if find "${LONGHUB_CLIENT_RELEASE_DIR}" -maxdepth 0 -perm /027 -print -quit | grep -q .; then
  echo "client release directory must not be group-writable or world-accessible" >&2
  exit 1
fi
[[ -d ${LONGHUB_WEB_ROOT}/portal && ! -L ${LONGHUB_WEB_ROOT}/portal &&
  -d ${LONGHUB_WEB_ROOT}/admin && ! -L ${LONGHUB_WEB_ROOT}/admin ]] || {
  echo "web release is missing Portal or Admin" >&2
  exit 1
}
for web_path in "${LONGHUB_WEB_ROOT}" "${LONGHUB_WEB_ROOT}/portal" "${LONGHUB_WEB_ROOT}/admin"; do
  [[ $(stat -Lc '%u' "${web_path}") == 0 ]] || { echo "web release paths must be root-owned" >&2; exit 1; }
  if find -L "${web_path}" -maxdepth 0 -perm /022 -print -quit | grep -q .; then
    echo "web release paths must not be group/world writable" >&2
    exit 1
  fi
done
if [[ -L ${LONGHUB_WEB_ROOT} ]]; then
  [[ $(stat -c '%u' "${LONGHUB_WEB_ROOT}") == 0 ]] || { echo "web release symlink must be root-owned" >&2; exit 1; }
fi

tmp=$(mktemp /etc/nginx/conf.d/.longhub-public.rendered.XXXXXX)
test_config=$(mktemp /tmp/longhub-nginx-test.XXXXXX)
backup=
output_swapped=false
restore_previous_config() {
  if [[ -n ${backup} && -f ${backup} ]]; then
    mv -Tf -- "${backup}" "${OUTPUT}"
  else
    rm -f -- "${OUTPUT}"
  fi
  output_swapped=false
}
cleanup_render() {
  local status=$?
  set +e
  if [[ ${output_swapped} == true ]]; then
    restore_previous_config
  fi
  rm -f -- "${tmp}" "${test_config}"
  [[ -z ${backup} ]] || rm -f -- "${backup}"
  return "${status}"
}
trap cleanup_render EXIT
envsubst "${NGINX_SUBSTITUTIONS}" \
  < "${TEMPLATE}" > "${tmp}"
if grep -q '\${LONGHUB_' "${tmp}"; then
  echo "unresolved LongHub Nginx placeholder" >&2
  exit 1
fi
if [[ $(grep -Fxc "${REQUIRED_CSP_HEADER}" "${tmp}") != 1 ]] ||
  [[ $(grep -Fc 'add_header Content-Security-Policy' "${tmp}") != 1 ]] ||
  [[ $(grep -Fxc "${REQUIRED_FRAME_HEADER}" "${tmp}") != 1 ]] ||
  [[ $(grep -Fc 'add_header X-Frame-Options' "${tmp}") != 1 ]]; then
  echo "rendered Nginx configuration is missing required browser security headers" >&2
  exit 1
fi
printf 'events {}\nhttp { include /etc/nginx/mime.types; include %s; }\n' "${tmp}" > "${test_config}"
nginx -t -c "${test_config}"

if [[ -e ${OUTPUT} || -L ${OUTPUT} ]]; then
  [[ -f ${OUTPUT} && ! -L ${OUTPUT} ]] || { echo "existing Nginx output must be a regular file" >&2; exit 1; }
  [[ $(stat -c '%u' "${OUTPUT}") == 0 ]] || { echo "existing Nginx output must be root-owned" >&2; exit 1; }
  if find "${OUTPUT}" -perm /022 -print -quit | grep -q .; then
    echo "existing Nginx output must not be group/world writable" >&2
    exit 1
  fi
  backup=$(mktemp /etc/nginx/conf.d/.longhub-public.backup.XXXXXX)
  cp --preserve=mode,ownership -- "${OUTPUT}" "${backup}"
fi
chown root:root "${tmp}"
chmod 0644 "${tmp}"
output_swapped=true
mv -Tf -- "${tmp}" "${OUTPUT}"

if ! nginx -t; then
  restore_previous_config
  echo "restored previous Nginx configuration after validation failure" >&2
  exit 1
fi
if systemctl is-active --quiet nginx; then
  if ! systemctl reload nginx; then
    restore_previous_config
    nginx -t >/dev/null 2>&1 || true
    systemctl reload nginx >/dev/null 2>&1 || true
    echo "restored previous Nginx configuration after reload failure" >&2
    exit 1
  fi
fi
output_swapped=false
