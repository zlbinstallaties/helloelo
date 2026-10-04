#!/bin/sh
set -u

compose_file="docker-compose.dig-builder-integration.yml"
run_id="$(date -u +%Y%m%dt%H%M%S)-$$"
project="dig-builder-ci-${run_id}"
artifact_dir="${DIG_BUILDER_ARTIFACT_DIR:-${TMPDIR:-/tmp}/dig-builder-integration-${run_id}}"
env_file="$(mktemp)"
mkdir -p "$artifact_dir"
umask 077
status=130
cleanup_done=0

compose() {
    docker compose -p "$project" -f "$compose_file" --env-file "$env_file" "$@"
}

save_runtime_state() {
    compose ps -a >"$artifact_dir/compose-ps.txt" 2>&1 || true
    compose logs --no-color >"$artifact_dir/container-logs.txt" 2>&1 || true
}

cleanup() {
    if [ "$cleanup_done" -eq 1 ]; then
        return
    fi
    cleanup_done=1
    save_runtime_state
    compose down --volumes --remove-orphans >"$artifact_dir/cleanup.log" 2>&1 || true
    rm -f "$env_file"
}
interrupt() {
    status=130
    printf '%s\n' "$status" >"$artifact_dir/exit-status"
    exit "$status"
}
trap cleanup EXIT INT TERM
trap interrupt INT TERM

if ! token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"; then
    status=1
    printf '%s\n' "$status" >"$artifact_dir/exit-status"
    exit "$status"
fi
printf 'BUILDER_ADMIN_TOKEN=%s\n' "$token" > "$env_file"

status=0
compose up --build -d db runner builder-api >"$artifact_dir/compose-up.log" 2>&1 || status=$?

if [ "$status" -eq 0 ]; then
    compose run --rm odoo odoo --no-http -d dig_builder_ci -i dig_builder \
        --stop-after-init \
        --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
        >"$artifact_dir/install-odoo.log" 2>&1 || status=$?
fi

if [ "$status" -eq 0 ]; then
    compose run --rm \
        -e DIG_BUILDER_SERVICE_URL=http://builder-api:8080 \
        -e DIG_BUILDER_SERVICE_TOKEN="$token" \
        odoo odoo shell --no-http -d dig_builder_ci <<'PY' >"$artifact_dir/configure-odoo.log" 2>&1 || status=$?
import os

params = env["ir.config_parameter"].sudo()
params.set_param("dig_builder.service_url", os.environ["DIG_BUILDER_SERVICE_URL"])
params.set_param("dig_builder.service_token", os.environ["DIG_BUILDER_SERVICE_TOKEN"])
env.cr.commit()
PY
fi

if [ "$status" -eq 0 ]; then
    compose run --rm odoo odoo shell --no-http -d dig_builder_ci <<'PY' >"$artifact_dir/verify-odoo-config.log" 2>&1 || status=$?
params = env["ir.config_parameter"].sudo()
service_url = params.get_param("dig_builder.service_url")
service_token = params.get_param("dig_builder.service_token")
assert service_url, "service URL is missing"
assert service_token, "service token is missing"
print("builder_service_url_configured=true")
print("builder_service_token_configured=true")
PY
fi

if [ "$status" -eq 0 ]; then
    compose run --rm \
        -e DIG_BUILDER_INTEGRATION=1 \
        odoo odoo -d dig_builder_ci -i dig_builder -u dig_builder \
        --test-enable --test-tags /dig_builder --stop-after-init \
        --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons \
        >"$artifact_dir/odoo-tests.log" 2>&1 || status=$?
fi

printf '%s\n' "$status" >"$artifact_dir/exit-status"
printf 'Integration artifacts: %s\n' "$artifact_dir"
exit "$status"
