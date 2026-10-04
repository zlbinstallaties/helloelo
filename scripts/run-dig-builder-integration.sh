#!/bin/sh
set -eu

compose_file="docker-compose.dig-builder-integration.yml"
project="dig-builder-ci"
env_file="$(mktemp)"
cleanup() {
    docker compose -p "$project" -f "$compose_file" --env-file "$env_file" down --volumes >/dev/null 2>&1 || true
    rm -f "$env_file"
}
trap cleanup EXIT INT TERM

token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
umask 077
printf 'BUILDER_ADMIN_TOKEN=%s\n' "$token" > "$env_file"

docker compose -p "$project" -f "$compose_file" --env-file "$env_file" up --build -d db runner builder-api
docker compose -p "$project" -f "$compose_file" --env-file "$env_file" run --rm odoo \
    odoo --db_host=db --db_port=5432 --db_user=odoo --db_password=odoo-ci-only \
    -d dig_builder_ci -i dig_builder --test-enable --stop-after-init \
    --addons-path=/mnt/extra-addons,/usr/lib/python3/dist-packages/odoo/addons
