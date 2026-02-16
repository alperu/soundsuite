import type { Metadata } from 'next'
import './globals.css'
import Navigation from '@/components/navigation'

export const metadata: Metadata = {
  title: 'Sound Suite',
  description: 'Document intelligence platform for legal case management',
}

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
