import type { MetadataRoute } from 'next'
import { isPubliclyHosted, siteUrl } from '@/lib/server/deps'

/**
 * What a crawler may look at.
 *
 * The landing page is the only thing here worth indexing. Everything under
 * `/v/`, `/history` and `/settings` is either per-visitor or an expensive
 * server render triggered by a URL a crawler would be inventing — and `/api`
 * spends provider quota, which is the one thing a crawl must never do.
 *
 * A deployment that is not publicly hosted disallows everything, so a preview
 * URL cannot end up in an index competing with the real one.
 */
export default function robots(): MetadataRoute.Robots {
  if (!isPubliclyHosted()) {
    return { rules: [{ userAgent: '*', disallow: '/' }] }
  }

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/api/', '/v/', '/history', '/settings'],
      },
    ],
    sitemap: `${siteUrl()}/sitemap.xml`,
  }
}
