import { NextResponse } from 'next/server';
import { provisionContainers } from '@/lib/containers';

export async function POST() {
  try {
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
