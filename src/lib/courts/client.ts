'use client';

/**
 * Frontend API client for the Courts admin / ref-picker.
 *
 * Mirrors the shape of `src/lib/personas/client.ts`. The matching backend
 * lives at `/api/courts` and `/api/courts/[id]`.
 */

export type CourtType = 'trial' | 'appellate' | 'supreme' | 'magistrate';

export const COURT_TYPES: CourtType[] = ['trial', 'appellate', 'supreme', 'magistrate'];

export interface Court {
  id: string;
  name: string;
  shortName?: string | null;
  jurisdictionId?: string | null;
  courtType?: CourtType | string | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  tags?: Record<string, unknown>;
  casesCount?: number;
  cases?: Array<{
    id: string;
    name: string;
    caseNumber: string | null;
    jurisdiction: string | null;
  }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CourtListResponse {
  courts: Court[];
  total: number;
  limit: number;
  offset: number;
}

export class CourtsApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not json */ }
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new CourtsApiError(res.status, msg, body);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export interface ListCourtsOpts {
  q?: string;
  type?: CourtType | string;
  limit?: number;
  offset?: number;
}

export function buildListQuery(opts: ListCourtsOpts): string {
  const params = new URLSearchParams();
  if (opts.q) params.set('q', opts.q);
  if (opts.type) params.set('type', opts.type);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function listCourts(opts: ListCourtsOpts = {}): Promise<CourtListResponse> {
  const res = await request<{ courts: Court[]; total: number; limit: number; offset: number }>(
    `/api/courts${buildListQuery(opts)}`,
  );
  return res;
}

export async function getCourt(id: string): Promise<Court> {
  const res = await request<{ court: Court }>(`/api/courts/${encodeURIComponent(id)}`);
  return res.court;
}

export interface CreateCourtBody {
  name: string;
  shortName?: string | null;
  jurisdictionId?: string | null;
  courtType?: CourtType | null;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
}

export async function createCourt(body: CreateCourtBody): Promise<Court> {
  const res = await request<{ court: Court }>('/api/courts', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.court;
}

export type UpdateCourtBody = Partial<CreateCourtBody>;

export async function updateCourt(id: string, body: UpdateCourtBody): Promise<Court> {
  const res = await request<{ court: Court }>(`/api/courts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return res.court;
}

export async function deleteCourt(id: string): Promise<void> {
  await request<{ ok: true }>(`/api/courts/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

// ---------- Haystack jurisdiction lookup (for the create form dropdown) ----------

export interface JurisdictionOption {
  id: string;
  label: string;
}

/**
 * Fetch jurisdictions through the same-origin haystack proxy so the create
 * form's dropdown gets real records. Falls back to an empty list silently.
 */
export async function listJurisdictionOptions(): Promise<JurisdictionOption[]> {
  try {
    const res = await fetch('/api/haystack-proxy/read?filter=jurisdiction', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null) as
      | { rows?: Array<Record<string, unknown>> }
      | null;
    const rows = data?.rows || [];
    return rows
      .map((r) => {
        const id = typeof r.id === 'string' ? r.id : '';
        const label =
          (typeof r.name === 'string' && r.name) ||
          (typeof r.code === 'string' && r.code) ||
          id;
        return { id, label };
      })
      .filter((j) => j.id);
  } catch {
    return [];
  }
}
