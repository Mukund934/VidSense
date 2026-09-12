import type { Metadata, Viewport } from 'next'
import Link from 'next/link'
import { AuthButton } from '@/components/auth-button'
import { NavLink } from '@/components/nav-link'
import { isSignedIn } from '@/lib/server/session'
import { siteUrl } from '@/lib/server/deps'
import './globals.css'

const DESCRIPTION =
  'Turn a YouTube video into searchable, evidence-grounded knowledge. Ask questions, find exact moments, and see the words behind every answer.'

export const metadata: Metadata = {
  // Without a base, every relative image in a link preview resolves against
  // nothing and the card renders blank.
  metadataBase: new URL(siteUrl()),
  title: {
    default: 'VidSense AI — Understand every video',
    template: '%s · VidSense',
  },
  description: DESCRIPTION,
  applicationName: 'VidSense',
  openGraph: {
    type: 'website',
    siteName: 'VidSense',
    title: 'VidSense AI — Understand every video',
    description: DESCRIPTION,
  },
  twitter: { card: 'summary', title: 'VidSense AI', description: DESCRIPTION },
  // Analysed pages are per-user and worth nothing to a crawler; the landing
  // page is the only thing here that wants indexing.
  robots: { index: true, follow: true },
}

export const viewport: Viewport = {
  // The accent, so a mobile browser's chrome joins the product rather than
  // sitting next to it. Two values, because the surface differs by scheme.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fcfcfd' },
    { media: '(prefers-color-scheme: dark)', color: '#22252d' },
  ],
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await isSignedIn()

  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col bg-surface">
        {/* Keyboard users should not have to tab the header on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50
                     focus:rounded-md focus:bg-accent focus:px-3 focus:py-2 focus:text-sm
                     focus:font-medium focus:text-on-accent"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-30 border-b border-line bg-surface/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6">
            <Link
              href="/"
              className="group flex items-center gap-2 font-semibold tracking-tight"
              aria-label="VidSense home"
            >
              <span
                aria-hidden
                className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[11px]
                           font-bold text-on-accent shadow-raised transition-transform
                           duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:scale-105"
              >
                VS
              </span>
              VidSense
            </Link>
            <nav className="flex items-center gap-5 text-sm" aria-label="Main">
              <NavLink href="/history">History</NavLink>
              <NavLink href="/settings">Settings</NavLink>
              <AuthButton signedIn={signedIn} />
            </nav>
          </div>
        </header>

        <main id="main" className="flex-1">
          {children}
        </main>

        <footer className="border-t border-line py-5 text-center text-xs text-muted">
          VidSense reads and reasons. It never downloads or stores video or audio.
        </footer>
      </body>
    </html>
  )
}
