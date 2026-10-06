#!/usr/bin/env bash
# Read-only check of a server before installing the DIG Builder. Changes nothing, prints no secrets
# (no environment variables, no container settings): only versions, ports and container names.
#
#   bash deploy/preflight.sh            (or paste it into the terminal of the VPS)

say() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

say "systeem"
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "gebruiker: $(id -un)  architectuur: $(uname -m)  cpu's: $(nproc 2>/dev/null)"
free -m 2>/dev/null | awk 'NR==2{print "geheugen: "$2" MB totaal, "$7" MB beschikbaar"}'
df -h / 2>/dev/null | awk 'NR==2{print "schijf: "$2" totaal, "$4" vrij"}'
echo "publiek ip: $(curl -s -m 5 https://api.ipify.org 2>/dev/null || echo 'onbekend (geen uitgaand internet?)')"

say "poorten: wie luistert er (22, 80, 443 en onze eigen 8070/8090/8100)"
if have ss; then ss -ltnp 2>/dev/null | awk 'NR==1 || /:(22|80|443|8070|8090|8100)[[:space:]]/'; else echo "ss ontbreekt"; fi

say "docker"
if have docker; then
  docker --version
  docker compose version 2>/dev/null || echo "docker compose ontbreekt"
  docker ps --format 'container: {{.Names}}   image: {{.Image}}   poorten: {{.Ports}}' 2>&1 | head -30
  echo "docker-netwerken: $(docker network ls --format '{{.Name}}' 2>/dev/null | tr '\n' ' ')"
else
  echo "docker is niet geinstalleerd"
fi

say "bestaande webserver of proxy"
for unit in nginx apache2 caddy traefik haproxy; do
  state=$(systemctl is-active "$unit" 2>/dev/null); [ "$state" = active ] && echo "$unit draait als systeemdienst"
done
have docker && docker ps --format '{{.Image}}' 2>/dev/null | grep -iE 'traefik|nginx|caddy|haproxy' | sed 's/^/in docker: /'

say "gereedschap"
for tool in git node bun curl; do
  have "$tool" && echo "$tool: $("$tool" --version 2>&1 | head -1)" || echo "$tool: ontbreekt"
done

say "firewall"
if have ufw; then ufw status 2>/dev/null | head -8; else echo "ufw niet aanwezig (de firewall van Hostinger zit buiten de server)"; fi

say "naam van de Odoo-testserver"
getent hosts odoo20.srv1938209.hstgr.cloud 2>/dev/null || echo "niet te vinden vanaf deze server"
echo
echo "Klaar. Er is niets veranderd."
