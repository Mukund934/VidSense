import type { MetadataRoute } from 'next'
import { siteUrl } from '@/lib/server/deps'

/**
 * One entry, honestly.
 *
 * Every other route is per-visitor or parameterised by a video id, so there is
 * nothing else a crawler could usefully be pointed at. A sitemap padded with
 * URLs that render private or empty pages is worse than a short one.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: siteUrl(), changeFrequency: 'weekly', priority: 1 }]
}
