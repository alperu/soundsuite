import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Sound Suite GPU Orchestrator',
  description: 'Multi-container lifecycle manager',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-800 antialiased">{children}</body>
    </html>
  );
}
