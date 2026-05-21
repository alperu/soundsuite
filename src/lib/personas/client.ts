'use client';

/**
 * Frontend API client for the Personas pool.
 * UI label is "Persona / Personas" but the underlying schema and
 * TypeScript identifiers stay `Person` and `PersonRole` for parity
 * with the XETO/Haystack ontology (see docs/xeto-haystack-research.md §4.0).
 *
 * Backend endpoints are owned by Agent A. This client tolerates the API
 * not being live yet — callers should `try/catch` and surface a friendly
 * error to the user.
 */

// ---------- Types ----------

/** Intrinsic markers — properties of the human, not the role they play. */
export type IntrinsicMarker =
  | 'person'
  | 'lawyer'
  | 'judge'
  | 'courtClerk'
  | 'courtReporter'
  | 'bailiff'
  | 'proSe'
  | 'self';

export const INTRINSIC_MARKERS: IntrinsicMarker[] = [
  'lawyer',
  'judge',
  'courtClerk',
  'courtReporter',
  'bailiff',
  'proSe',
  'self',
];

/** Contextual role tags — properties of a Person *within a scope* (case/motion). */
export type ContextualRole =
  | 'movant'
  | 'respondent'
  | 'plaintiff'
  | 'defendant'
  | 'lawyerMovant'
  | 'lawyerRespondent'
  | 'lawyerPlaintiff'
  | 'lawyerDefendant'
  | 'witness'
  | 'expert';

export interface Persona {
  id: string;
  displayName: string;
  email?: string | null;
  barNumber?: string | null;
  jurisdiction?: string | null;
  /** Intrinsic markers, as a string array (e.g. ['lawyer','self']). */
  markers: IntrinsicMarker[];
  /** Total bindings count, if the server returns it. */
  rolesCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface PersonaListResponse {
  personas: Persona[];
  total: number;
  limit: number;
  offset: number;
}

export interface PersonRoleBinding {
  id: string;
  personId: string;
  /** Scope: either `case` or `motion`. */
  scopeKind: 'case' | 'motion';
  scopeId: string;
  /** Display label for the scope (e.g. case causeNo, motion title). */
  scopeLabel?: string | null;
  caseId?: string | null;
  caseLabel?: string | null;
  motionId?: string | null;
  motionLabel?: string | null;
  /** Contextual role tags within this binding. */
  roles: ContextualRole[];
  appearedOn?: string | null;
  withdrewOn?: string | null;
  createdAt?: string;
}

export interface PersonaRolesResponse {
  roles: PersonRoleBinding[];
}

// ---------- Error helper ----------

export class PersonasApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
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
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`);
    throw new PersonasApiError(res.status, msg, body);
  }
  // 204 etc.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ---------- List ----------

export interface ListPersonasOpts {
  tags?: IntrinsicMarker[];
  q?: string;
  limit?: number;
  offset?: number;
}

export function buildListQuery(opts: ListPersonasOpts): string {
  const params = new URLSearchParams();
  for (const t of opts.tags || []) params.append('tag', t);
  if (opts.q) params.set('q', opts.q);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  if (opts.offset != null) params.set('offset', String(opts.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export async function listPersonas(
  opts: ListPersonasOpts = {},
): Promise<PersonaListResponse> {
  return request<PersonaListResponse>(`/api/personas${buildListQuery(opts)}`);
}

// ---------- CRUD ----------

/** Server wraps single-persona responses as `{ persona: {...} }`. Unwrap. */
type PersonaEnvelope = { persona: Persona };

export async function getPersona(id: string): Promise<Persona> {
  const env = await request<PersonaEnvelope>(`/api/personas/${encodeURIComponent(id)}`);
  return env.persona;
}

export interface CreatePersonaBody {
  displayName: string;
  email?: string | null;
  barNumber?: string | null;
  jurisdiction?: string | null;
  markers?: IntrinsicMarker[];
}

export async function createPersona(body: CreatePersonaBody): Promise<Persona> {
  const env = await request<PersonaEnvelope>('/api/personas', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return env.persona;
}

export interface UpdatePersonaBody {
  displayName?: string;
  email?: string | null;
  barNumber?: string | null;
  jurisdiction?: string | null;
  markers?: IntrinsicMarker[];
}

export async function updatePersona(
  id: string,
  body: UpdatePersonaBody,
): Promise<Persona> {
  const env = await request<PersonaEnvelope>(`/api/personas/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return env.persona;
}

// ---------- Role bindings ----------

export async function getPersonaRoles(id: string): Promise<PersonaRolesResponse> {
  return request<PersonaRolesResponse>(`/api/personas/${encodeURIComponent(id)}/roles`);
}

export interface AddPersonaRoleBody {
  scopeKind: 'case' | 'motion';
  scopeId: string;
  roles: ContextualRole[];
  appearedOn?: string | null;
  withdrewOn?: string | null;
}

export async function addPersonaRole(
  id: string,
  body: AddPersonaRoleBody,
): Promise<PersonRoleBinding> {
  return request<PersonRoleBinding>(`/api/personas/${encodeURIComponent(id)}/roles`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface UpdatePersonaRoleBody {
  roles?: ContextualRole[];
  appearedOn?: string | null;
  withdrewOn?: string | null;
}

export async function updatePersonaRole(
  personaId: string,
  bindingId: string,
  body: UpdatePersonaRoleBody,
): Promise<PersonRoleBinding> {
  return request<PersonRoleBinding>(
    `/api/personas/${encodeURIComponent(personaId)}/roles/${encodeURIComponent(bindingId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
}

export async function removePersonaRole(
  personaId: string,
  bindingId: string,
): Promise<void> {
  await request<void>(
    `/api/personas/${encodeURIComponent(personaId)}/roles/${encodeURIComponent(bindingId)}`,
    { method: 'DELETE' },
  );
}

// ---------- Merge ----------

export interface MergePersonasBody {
  keepId: string;
  mergeIds: string[];
}

export async function mergePersonas(
  keepId: string,
  mergeIds: string[],
): Promise<Persona> {
  return request<Persona>('/api/personas/merge', {
    method: 'POST',
    body: JSON.stringify({ keepId, mergeIds } satisfies MergePersonasBody),
  });
}

// ---------- Haystack scope typeahead ----------
// Helper for the role-binding modal: fetches `case` or `motion` records via
// the read endpoint so the user can pick a scope. The backend may return
// different shapes; we normalise to a minimal {id,label}.

export interface HaystackHit {
  id: string;
  label: string;
}

export async function searchHaystackScopes(
  kind: 'case' | 'motion',
  q: string,
): Promise<HaystackHit[]> {
  const params = new URLSearchParams({ filter: kind });
  if (q) params.set('q', q);
  const res = await fetch(`/api/haystack/read?${params.toString()}`);
  if (!res.ok) return [];
  const data = await res.json().catch(() => null) as
    | { rows?: Array<Record<string, unknown>> }
    | null;
  const rows = data?.rows || [];
  return rows.map((r) => {
    const id = String(r.id || '');
    const label =
      (typeof r.causeNo === 'string' && r.causeNo) ||
      (typeof r.title === 'string' && r.title) ||
      (typeof r.displayName === 'string' && r.displayName) ||
      (typeof r.motionType === 'string' && r.motionType) ||
      id;
    return { id, label };
  }).filter(h => h.id);
}
