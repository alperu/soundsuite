/** @jest-environment node */
import { NextResponse } from 'next/server';
import { CONTAINER_PREFIX } from '@/lib/state';

describe('sidecar jest harness', () => {
  it('resolves the @/ path alias', () => {
    expect(CONTAINER_PREFIX).toBe('ss-');
  });

  it('resolves next/server for route tests', () => {
    expect(typeof NextResponse.json).toBe('function');
  });
});
