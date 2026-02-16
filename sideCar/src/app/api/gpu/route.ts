import { NextResponse } from 'next/server';
import { discoverGpus } from '@/lib/gpu';

export async function GET() {
  try {
    const gpus = await discoverGpus();
    return NextResponse.json(
      { gpus },
      { headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }
}
