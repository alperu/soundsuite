import { NextResponse } from 'next/server';
import { provisionContainers } from '@/lib/containers';
import { masterReady } from '@/lib/state';

export async function POST() {
  try {
    // GPU authority: provisioning starts GPU work; it waits for sidecarmaster.
    if (!masterReady()) {
      return NextResponse.json(
        { error: 'Waiting for sidecarmaster (the GPU authority) before provisioning GPU roles' },
        { status: 409, headers: { 'Access-Control-Allow-Origin': '*' } },
      );
    }
    const result = await provisionContainers();
    return NextResponse.json(result, {
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
