#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "verify-assets.sh must run as root because nginx -t opens protected paths" >&2
  exit 1
fi

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
template=${root}/infrastructure/nginx/longhub-public.conf.template
deployment=${root}/infrastructure/deployment
bash -n \
  "${deployment}/scripts/install-release.sh" \
  "${deployment}/scripts/render-nginx.sh" \
  "${deployment}/scripts/health-check.sh" \
  "${deployment}/scripts/migration-release-gate.sh" \
  "${deployment}/scripts/rollback-release.sh"
node --check "${deployment}/scripts/runtime-probe.mjs"
node --check "${deployment}/scripts/production-e2e.mjs"

! grep -Eq '154-9-26-158|127\.0\.0\.1:(8080|8090)' "${template}"
grep -q 'longhub_sensitive_ip' "${template}"
grep -q 'https://\${LONGHUB_SERVER_NAME}\$request_uri' "${template}"
grep -q 'disable_symlinks on from=\${LONGHUB_CLIENT_RELEASE_DIR}' "${template}"
grep -q 'proxy_set_header Host \${LONGHUB_SERVER_NAME}' "${template}"
! grep -q 'proxy_add_x_forwarded_for' "${template}"
[[ $(grep -Fxc "  add_header Content-Security-Policy \"default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'\" always;" "${template}") == 1 ]]
[[ $(grep -Fxc '  add_header X-Frame-Options "DENY" always;' "${template}") == 1 ]]
! grep -q 'source "\${ENV_FILE}"' "${deployment}/scripts/render-nginx.sh"
grep -q 'readonly TLS_DIRECTORY=/etc/longhub/tls' "${deployment}/scripts/render-nginx.sh"
grep -q 'TLS private key must not be group/world accessible' "${deployment}/scripts/render-nginx.sh"
grep -q 'rendered Nginx configuration is missing required browser security headers' \
  "${deployment}/scripts/render-nginx.sh"
grep -q 'if systemctl is-active --quiet nginx' "${deployment}/scripts/render-nginx.sh"
grep -q 'readonly deployment_lock=/run/lock/longhub-deployment.lock' \
  "${deployment}/scripts/install-release.sh"
grep -q 'flock -n 9' "${deployment}/scripts/install-release.sh"
grep -q 'flock -n 9' "${deployment}/scripts/render-nginx.sh"
grep -q 'flock -n 9' "${deployment}/scripts/rollback-release.sh"
grep -q 'flock -n 9' "${deployment}/scripts/health-check.sh"
grep -q 'runuser -u longhub-executor -- test -r' "${deployment}/scripts/install-release.sh"
grep -q 'longhub-api longhub-migrator www-data' "${deployment}/scripts/install-release.sh"
grep -q 'infrastructure/deployment/scripts/runtime-probe.mjs' \
  "${deployment}/scripts/install-release.sh"
! grep -q '^KNOWLEDGE_DATA_KEY=' "${deployment}/env/cloud-api.env.example"
! grep -Eq '^(CLIENT_UPDATE|SKILL)_SIGNING_(PRIVATE|PUBLIC)_KEY_PEM=' \
  "${deployment}/env/cloud-api.env.example"
[[ $(grep -c '^LoadCredential=' "${deployment}/systemd/longhub-cloud-api.service") == 8 ]]
grep -Fq 'LoadCredential=client-update-private.pem:/etc/longhub/keys/client-update-private.pem' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -Fq 'LoadCredential=cloud-skill-private.pem:/etc/longhub/keys/cloud-skill-private.pem' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -Fq 'LoadCredential=cloud-plugin-private.pem:/etc/longhub/keys/cloud-plugin-private.pem' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -Fq 'LoadCredential=cloud-cli-private.pem:/etc/longhub/keys/cloud-cli-private.pem' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -Fq 'InaccessiblePaths=/etc/longhub/keys /etc/longhub/tls' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -Fq 'find "${private_dir}" -type f -print0' "${deployment}/scripts/health-check.sh"
grep -q '^Requires=longhub-migrate.service longhub-executor.service$' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -q '^ExecStartPre=/bin/bash infrastructure/deployment/scripts/migration-release-gate.sh check$' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -q '^ExecStart=/bin/bash infrastructure/deployment/scripts/migration-release-gate.sh exec-api$' \
  "${deployment}/systemd/longhub-cloud-api.service"
grep -q '^Requires=longhub-migrate.service$' "${deployment}/systemd/longhub-executor.service"
grep -q '^ExecStart=/bin/bash infrastructure/deployment/scripts/migration-release-gate.sh exec-executor$' \
  "${deployment}/systemd/longhub-executor.service"
grep -q '^ExecStart=/bin/bash infrastructure/deployment/scripts/migration-release-gate.sh run$' \
  "${deployment}/systemd/longhub-migrate.service"
grep -q '^RuntimeDirectoryPreserve=yes$' "${deployment}/systemd/longhub-migrate.service"
grep -q '^TimeoutStartSec=120$' "${deployment}/systemd/longhub-migrate.service"
grep -q '^Environment=PGCONNECT_TIMEOUT=10$' "${deployment}/systemd/longhub-migrate.service"
! grep -q '^RemainAfterExit=' "${deployment}/systemd/longhub-migrate.service"
grep -q '^LONGHUB_WEB_ROOT=/var/www/longhub/current$' "${deployment}/env/site.env.example"
grep -q 'createRequire' "${deployment}/scripts/runtime-probe.mjs"
grep -q 'schema_migrations must be read-only' "${deployment}/scripts/runtime-probe.mjs"
grep -q 'parsed.search.length > 0' "${deployment}/scripts/runtime-probe.mjs"
grep -q 'FROM pg_auth_members AS membership' "${deployment}/scripts/runtime-probe.mjs"
grep -q 'unexpected_other_database_access' "${deployment}/scripts/runtime-probe.mjs"
grep -Fq "namespace.nspname !~ '^pg_'" "${deployment}/scripts/runtime-probe.mjs"
grep -q 'health check must run from the installed current release' \
  "${deployment}/scripts/health-check.sh"
grep -q 'active release changed during the health check' "${deployment}/scripts/health-check.sh"
grep -q 'render-nginx.sh" --deployment-lock-held' "${deployment}/scripts/rollback-release.sh"
grep -q 'stop_nginx_fail_closed' "${deployment}/scripts/rollback-release.sh"

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify \
    "${deployment}/systemd/longhub-migrate.service" \
    "${deployment}/systemd/longhub-executor.service" \
    "${deployment}/systemd/longhub-cloud-api.service"
fi

tmpdir=$(mktemp -d)
trap 'rm -rf -- "${tmpdir}"' EXIT
openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj '/CN=longhub.test' \
  -keyout "${tmpdir}/key.pem" -out "${tmpdir}/cert.pem" >/dev/null 2>&1
mkdir -p \
  "${tmpdir}/releases" \
  "${tmpdir}/cloud-plugin-releases" \
  "${tmpdir}/cloud-cli-releases" \
  "${tmpdir}/www/portal" \
  "${tmpdir}/www/admin"

export LONGHUB_SERVER_NAME=longhub.test
export LONGHUB_TLS_CERTIFICATE=${tmpdir}/cert.pem
export LONGHUB_TLS_CERTIFICATE_KEY=${tmpdir}/key.pem
export LONGHUB_CLIENT_RELEASE_DIR=${tmpdir}/releases
export LONGHUB_CLOUD_PLUGIN_RELEASE_DIR=${tmpdir}/cloud-plugin-releases
export LONGHUB_CLOUD_CLI_RELEASE_DIR=${tmpdir}/cloud-cli-releases
export LONGHUB_CLOUD_API_UPSTREAM=127.0.0.1:8081
export LONGHUB_WEB_ROOT=${tmpdir}/www
substitutions='${LONGHUB_SERVER_NAME} ${LONGHUB_TLS_CERTIFICATE} ${LONGHUB_TLS_CERTIFICATE_KEY} '
substitutions+='${LONGHUB_CLIENT_RELEASE_DIR} ${LONGHUB_CLOUD_PLUGIN_RELEASE_DIR} '
substitutions+='${LONGHUB_CLOUD_CLI_RELEASE_DIR} ${LONGHUB_CLOUD_API_UPSTREAM} ${LONGHUB_WEB_ROOT}'
envsubst "${substitutions}" \
  < "${template}" > "${tmpdir}/site.conf"
! grep -q '\${LONGHUB_' "${tmpdir}/site.conf"
[[ $(grep -Fc 'add_header Content-Security-Policy' "${tmpdir}/site.conf") == 1 ]]
grep -Fqx "  add_header Content-Security-Policy \"default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'\" always;" "${tmpdir}/site.conf"
[[ $(grep -Fc 'add_header X-Frame-Options "DENY" always;' "${tmpdir}/site.conf") == 1 ]]

printf 'events {}\nhttp { include /etc/nginx/mime.types; include %s; }\n' \
  "${tmpdir}/site.conf" > "${tmpdir}/nginx.conf"
nginx -t -c "${tmpdir}/nginx.conf"
printf 'LongHub deployment assets: OK\n'
