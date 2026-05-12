import { NextRequest, NextResponse } from 'next/server';
import { persistAndApplyHostOs } from '@/lib/setup-overrides';
import type { HostOsValue } from '@/lib/sidecar-config';

const cors = { 'Access-Control-Allow-Origin': '*' };

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const os = body?.os;
    if (os !== 'mac-docker-ollama' && os !== 'windows-docker-wsl2' && os !== 'linux') {
      return NextResponse.json(
        { error: "os must be one of 'mac-docker-ollama' | 'windows-docker-wsl2' | 'linux'" },
        { status: 400, headers: cors },
      );
    }
    persistAndApplyHostOs(os as HostOsValue);
    return NextResponse.json({ ok: true, os }, { headers: cors });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500, headers: cors });
  }
}
