# shellcheck shell=bash disable=SC2034
# config.sh - SoundSuite stack on basws42. Read by lib.sh. Local only (not in git).
NAME=soundsuite
SSH_HOST=basws42
STACK_DIR='C:\sidecar-deploy\soundsuite'
COMPOSE_PROJECT=soundsuite
COMPOSE_FILE=docker-compose.yml
NET_CT=soundsuite-net   # network owner (<stack>-net): app, netbird and caddy use network_mode container:soundsuite-net
APP_CT=soundsuite
NETBIRD_CT=soundsuite-netbird
CADDY_CT=soundsuite-caddy
EXTRA_CTS="soundsuite-redis"
IMAGE=soundsuite
DOCKERFILE=Dockerfile
BUILD_CONTEXT=.
HEALTH_PORT=3000
HEALTH_PATH=/api/health
HEALTH_TIMEOUT=600
ENV_FILE=soundsuite.env
REQUIRED_ENV=""
ENTRYPOINT_FILES="docker/netbird-entrypoint.sh docker/caddy-entrypoint.sh"
STATUS_IMAGES="sidecar-caddy netbirdio/netbird redis"
SETTINGS_URL="http://basws42:3000/admin/netbird"
# Big local files that are not part of the build.
PACK_EXCLUDE_GLOBS="data/* logs/* screenshots/* marketing/* tsconfig.tsbuildinfo"
