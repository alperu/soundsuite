/** @jest-environment node */
/**
 * Every container the sidecar creates carries the compose labels that put it
 * in one Docker Desktop group. Nothing here talks to Docker: the role create
 * call is caught at the `http` module, and the companions go through the fake
 * CompanionDeps the NetBird tests use.
 */
import type { EventEmitter as EventEmitterType } from 'events';

jest.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

/** Catch http.request: record what would be sent, answer 201. */
const sent: Array<{ method?: string; path?: string; body: string }> = [];
jest.mock('http', () => {
  const { EventEmitter } = require('events');
  return {
    request: (opts: { method?: string; path?: string }, cb?: (res: unknown) => void) => {
      const call = { method: opts.method, path: opts.path, body: '' };
      sent.push(call);
      const req = new EventEmitter() as EventEmitterType & {
        end: () => void; write: (s: string) => void; setTimeout: () => void; destroy: () => void;
      };
      req.write = (s: string) => { call.body += s; };
      req.end = () => {
        const res = new EventEmitter() as EventEmitterType & { statusCode?: number };
        res.statusCode = 201;
        setImmediate(() => {
          cb?.(res);
          res.emit('data', Buffer.from('{"Id":"0123abcd"}'));
          res.emit('end');
        });
      };
      req.setTimeout = () => {};
      req.destroy = () => {};
      return req;
    },
  };
});

import { composeLabels, composeProject, DEFAULT_COMPOSE_PROJECT } from '@/lib/compose-labels';
import { createContainer, buildExpectedConfig } from '@/lib/docker';
import { caddySpec, ensureCompanion, netbirdSpec, type CompanionDeps } from '@/lib/netbird-companion';
import { readSettings } from '@/lib/netbird';
import fs from 'fs';
import os from 'os';
import path from 'path';

const saved = { project: process.env.SS_COMPOSE_PROJECT, dockerHost: process.env.DOCKER_HOST };
beforeAll(() => { process.env.DOCKER_HOST = '/tmp/made-up-docker.sock'; }); // never dialled: http is mocked
afterAll(() => {
  if (saved.dockerHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = saved.dockerHost;
  if (saved.project === undefined) delete process.env.SS_COMPOSE_PROJECT; else process.env.SS_COMPOSE_PROJECT = saved.project;
});
beforeEach(() => { delete process.env.SS_COMPOSE_PROJECT; sent.length = 0; });

const group = (project: string, service: string) => ({
  'com.docker.compose.project': project,
  'com.docker.compose.service': service,
  'com.docker.compose.oneoff': 'False',
  'com.docker.compose.container-number': '1',
});

describe('composeProject / composeLabels', () => {
  it('uses "sidecar" without the env', () => {
    expect(DEFAULT_COMPOSE_PROJECT).toBe('sidecar');
    expect(composeLabels('embedding')).toEqual(group('sidecar', 'embedding'));
  });

  it('reads SS_COMPOSE_PROJECT at call time', () => {
    process.env.SS_COMPOSE_PROJECT = 'gpu_stack-2';
    expect(composeProject()).toBe('gpu_stack-2');
    delete process.env.SS_COMPOSE_PROJECT;
    expect(composeProject()).toBe('sidecar');
  });

  it('falls back to "sidecar" for a name compose would refuse', () => {
    for (const bad of ['Upper', 'has space', '-lead', 'semi;colon', '_lead']) {
      process.env.SS_COMPOSE_PROJECT = bad;
      expect(composeProject()).toBe('sidecar');
    }
  });

  it('never sets the labels that make docker compose claim a container', () => {
    const keys = Object.keys(composeLabels('x'));
    expect(keys).not.toContain('com.docker.compose.config-hash');
    expect(keys).not.toContain('com.docker.compose.project.config_files');
    expect(keys).not.toContain('com.docker.compose.project.working_dir');
  });
});

describe('role containers (docker.ts createContainer)', () => {
  const createBody = () => {
    const c = sent.find((s) => s.method === 'POST' && s.path?.startsWith('/containers/create'));
    expect(c).toBeDefined();
    return JSON.parse(c!.body);
  };

  it('sends the labels with the default project', async () => {
    await createContainer('embedding');
    expect(createBody().Labels).toEqual(group('sidecar', 'embedding'));
  });

  it('sends the project from SS_COMPOSE_PROJECT', async () => {
    process.env.SS_COMPOSE_PROJECT = 'made-up-stack';
    await createContainer('rlm-sandbox');
    expect(createBody().Labels).toEqual(group('made-up-stack', 'rlm-sandbox'));
  });

  it('keeps labels out of drift detection, so no running container is recreated', () => {
    expect(Object.keys(buildExpectedConfig('embedding'))).not.toContain('Labels');
  });
});

describe('NetBird and Caddy companions', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const nb = () => netbirdSpec('abc', 'ss-sidecar', 'v:/c', '/c/nb', readSettings(dir), 'h', 'fp');
  const cd = () => caddySpec('abc', 'ss-sidecar', 'v:/c', '/c/nb', 'example.test {\n}\n', 'fp');

  it('both specs carry the labels next to their own', () => {
    expect(nb().body.Labels).toMatchObject({ ...group('sidecar', 'netbird'), 'sidecar.companion': 'netbird' });
    expect(cd().body.Labels).toMatchObject({ ...group('sidecar', 'caddy'), 'sidecar.companion': 'caddy' });
  });

  it('the env changes the labels but not the spec hash', () => {
    const before = { nb: nb().hash, cd: cd().hash };
    process.env.SS_COMPOSE_PROJECT = 'made-up-stack';
    expect(nb().body.Labels).toMatchObject(group('made-up-stack', 'netbird'));
    expect(nb().hash).toBe(before.nb);
    expect(cd().hash).toBe(before.cd);
  });

  it('the create call receives the labels', async () => {
    const bodies: Record<string, unknown>[] = [];
    const deps = {
      inspect: async () => null,
      create: async (_n: string, body: Record<string, unknown>) => { bodies.push(body); },
      start: async () => {},
      pull: async () => true,
    } as unknown as CompanionDeps;
    const r = await ensureCompanion(deps, 'ss-sidecar-caddy', cd(), 'abc', Date.now());
    expect(r.state).toBe('created');
    expect(bodies[0].Labels).toMatchObject(group('sidecar', 'caddy'));
  });
});
