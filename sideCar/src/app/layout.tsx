import type { Metadata } from 'next';
import './globals.css';
import SideMenu from '@/components/side-menu';

export const metadata: Metadata = {
  title: 'Sound Suite GPU Orchestrator',
  description: 'Multi-container lifecycle manager',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-800 antialiased">
        <div className="flex min-h-screen">
          <SideMenu />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </body>
    </html>
  );
}
