import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * /api: CORS, as before. Pages: pass the path to the root layout in
 * x-sidecar-path, so it can send signed-out users to /login. The layout does the
 * real session check (it needs Node crypto and the key file; middleware runs on edge).
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith('/api/')) {
    if (request.method === 'OPTIONS') {
      return new NextResponse(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    const response = NextResponse.next();
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  }
  const headers = new Headers(request.headers);
  headers.set('x-sidecar-path', pathname + search);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
