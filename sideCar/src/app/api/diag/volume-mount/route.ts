import { NextResponse } from 'next/server';
import { getConfigVolumeKind } from '@/lib/diag';

const cors = { 'Access-Control-Allow-Origin': '*' };

export async function GET() {
  try {
    const info = getConfigVolumeKind('/app/config');
    return NextResponse.json(info, { headers: cors });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, kind: 'unknown', path: '/app/config', durable: false, note: '' },
      { status: 500, headers: cors },
    );
  }
}
