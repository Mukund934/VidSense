import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'VidSense AI — Understand every video',
  description:
    'Turn a YouTube video into searchable, evidence-grounded knowledge. Ask questions, find exact moments, and see the words behind every answer.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh flex flex-col">
        <header className="border-b border-line">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span
                aria-hidden
                className="grid h-6 w-6 place-items-center rounded bg-accent text-[11px] font-bold text-white"
              >
                VS
              </span>
              VidSense
            </Link>
            <nav className="flex items-center gap-5 text-sm text-muted">
              <Link href="/history" className="hover:text-ink">
                History
              </Link>
              <Link href="/settings" className="hover:text-ink">
                Settings
              </Link>
            </nav>
          </div>
        </header>

        <main className="flex-1">{children}</main>

        <footer className="border-t border-line py-5 text-center text-xs text-muted">
          VidSense reads and reasons. It never downloads or stores video or audio.
        </footer>
      </body>
    </html>
  )
}
