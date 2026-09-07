import type { NextConfig } from 'next'

const config: NextConfig = {
  // The library under src/ is consumed directly as TypeScript.
  typedRoutes: true,
  images: {
    // YouTube thumbnails are the only remote images the product renders.
    remotePatterns: [{ protocol: 'https', hostname: 'i.ytimg.com' }],
  },
}

export default config
