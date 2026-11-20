/**
 * Docker Compose labels for every container the sidecar creates.
 *
 * Docker Desktop groups containers into one row by the label
 * `com.docker.compose.project`, the way a compose stack shows. The sidecar
 * creates its containers through the Docker API, so without these labels
 * ss-sidecar, ss-cuda, the role containers and the NetBird/Caddy companions
 * each show as a loose row.
 *
 * The labels are cosmetic for the sidecar: nothing here reads them back.
 * They are kept OUT of drift detection (buildExpectedConfig) and out of the
 * companion spec hash, so adding them never recreates a running container.
 * A container gets them the next time the sidecar creates it.
 *
 * What the labels mean to the `docker compose` CLI (see docs/CONFIGURATION.md):
 * Compose lists its own containers with the filter project label AND
 * `com.docker.compose.config-hash` (getDefaultFilters in docker/compose
 * pkg/compose/containers.go). We never set config-hash, config_files or
 * working_dir, so `docker compose ps/down/up --remove-orphans` do not select
 * these containers. The one sweep without config-hash
 * (removePreStartHookContainers in down.go) also needs a pre_start hook label,
 * which we never set either. Docker Desktop's group Stop/Delete buttons are a separate
 * thing: they act on every container in the group, the agent too.
 *
 * The launchers (public/sideCar/scripts/start.sh, start.bat,
 * scripts/start-docker-agent.*) set the same labels on the agent container and
 * pass SS_COMPOSE_PROJECT through, so the agent and its children share a group.
 */
import { createLogger } from './logger';

const log = createLogger('compose-labels');

export const DEFAULT_COMPOSE_PROJECT = 'sidecar';

/** Compose's own rule for a project name. The launchers check the same rule. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

let warnedFor: string | null = null;

/** The compose project name: SS_COMPOSE_PROJECT, else "sidecar". Read at call time. */
export function composeProject(): string {
  const raw = (process.env.SS_COMPOSE_PROJECT || '').trim();
  if (!raw) return DEFAULT_COMPOSE_PROJECT;
  if (PROJECT_NAME.test(raw)) return raw;
  if (warnedFor !== raw) {
    warnedFor = raw;
    log.warn(`SS_COMPOSE_PROJECT="${raw}" is not a valid compose project name (a-z, 0-9, _ and -, first a letter or digit); using "${DEFAULT_COMPOSE_PROJECT}"`);
  }
  return DEFAULT_COMPOSE_PROJECT;
}

/** Labels that put one container into the sidecar's Docker Desktop group. */
export function composeLabels(service: string): Record<string, string> {
  return {
    'com.docker.compose.project': composeProject(),
    'com.docker.compose.service': service,
    'com.docker.compose.oneoff': 'False',
    'com.docker.compose.container-number': '1',
  };
}
