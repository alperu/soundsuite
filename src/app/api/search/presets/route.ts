import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';

export const dynamic = 'force-dynamic';

/** Shape stored in `settings` — mirrors SearchPreset['settings'] in
 *  search-interface.tsx. The API treats it as an opaque JSON blob so the
 *  client can evolve the shape behind its own `version` field. */
interface PresetPayload {
  id: string;
  name: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  settings: unknown;
}

function toWire(p: { id: string; name: string; version: number; settings: unknown; createdAt: Date; updatedAt: Date }) {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    settings: p.settings,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** GET /api/search/presets — list all saved presets, oldest first. */
export async function GET() {
  try {
    const presets = await prisma.searchPreset.findMany({ orderBy: { createdAt: 'asc' } });
    return NextResponse.json({ presets: presets.map(toWire) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}

/**
 * POST /api/search/presets — upsert one preset ({preset}) or many
 * ({presets: [...]}, used by the one-time IndexedDB migration).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const items: PresetPayload[] = Array.isArray(body?.presets)
      ? body.presets
      : body?.preset ? [body.preset] : [];
    if (items.length === 0) {
      return NextResponse.json({ error: 'preset or presets required' }, { status: 400 });
    }
    for (const p of items) {
      if (!p?.id || typeof p.name !== 'string' || !p.name.trim() || p.settings === undefined) {
        return NextResponse.json({ error: 'each preset needs id, name, settings' }, { status: 400 });
      }
    }
    const saved = [];
    for (const p of items) {
      const data = {
        name: p.name.trim(),
        version: p.version ?? 1,
        settings: p.settings as object,
      };
      saved.push(await prisma.searchPreset.upsert({
        where: { id: p.id },
        create: { id: p.id, ...data, ...(p.createdAt ? { createdAt: new Date(p.createdAt) } : {}) },
        update: data,
      }));
    }
    return NextResponse.json({ presets: saved.map(toWire) });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'failed' }, { status: 500 });
  }
}
