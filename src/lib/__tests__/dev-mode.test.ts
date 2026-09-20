/**
 * @jest-environment node
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { isDevMode, devModeMarkerPath, DEV_MODE_MARKER } from '../dev-mode';

describe('dev-mode marker', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'ss-dev-mode-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is off when the marker file is absent', () => {
    expect(isDevMode(root)).toBe(false);
  });

  it('is on only while config/dev-mode exists', () => {
    mkdirSync(path.join(root, 'config'), { recursive: true });
    writeFileSync(devModeMarkerPath(root), '');
    expect(isDevMode(root)).toBe(true);
    rmSync(devModeMarkerPath(root));
    expect(isDevMode(root)).toBe(false);
  });

  it('resolves the marker under the given root', () => {
    expect(devModeMarkerPath(root)).toBe(path.join(root, DEV_MODE_MARKER));
    expect(DEV_MODE_MARKER).toBe(path.join('config', 'dev-mode'));
  });

  it('is off for an unreadable root instead of throwing', () => {
    expect(isDevMode(path.join(root, 'missing', 'deeper'))).toBe(false);
  });
});
