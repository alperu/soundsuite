import type { Metadata } from 'next'
import './globals.css'
import Navigation from '@/components/navigation'

export const metadata: Metadata = {
  title: 'Sound Suite',
  description: 'Document intelligence platform for legal case management',
}

// Sound Suite is a live single-user dashboard backed by SQLite/LanceDB — every
// page reflects current DB state, so nothing should be statically baked at
// build time. Forcing dynamic rendering app-wide stops `next build` from trying
// to prerender DB-backed pages (which fails against the empty build-time DB)
// and makes runtime always read the real database.
export const dynamic = 'force-dynamic'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <div className="flex h-screen overflow-hidden">
          <Navigation />
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}
