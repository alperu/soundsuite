/** Numeric dotted-version compare: negative ⇒ a < b. */
export function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * GET http://host:port/api/version on an Ollama endpoint. Null when it is
 * unreachable (stopped container, NAT'd host) or answers without a version.
 */
export async function probeOllamaVersion(host: string, port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://${host}:${port}/api/version`, {
      signal: AbortSignal.timeout(2500),
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    const version = String(data?.version || '');
    return version || null;
  } catch {
    return null;
  }
}
