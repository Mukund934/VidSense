import type { NextConfig } from 'next'

import { STATIC_SECURITY_HEADERS } from './lib/security-headers'

const config: NextConfig = {
  // The library under src/ is consumed directly as TypeScript.
  typedRoutes: true,
  // The version and the framework are a free hint to anyone scanning.
  poweredByHeader: false,
  images: {
    // YouTube thumbnails are the only remote images the product renders.
    remotePatterns: [{ protocol: 'https', hostname: 'i.ytimg.com' }],
  },
  async headers() {
    return [
      {
        // Everything, including the static assets the proxy does not see. The
        // per-request CSP is set in `proxy.ts`, because its nonce cannot be
        // known here.
        source: '/:path*',
        headers: STATIC_SECURITY_HEADERS.map(([key, value]) => ({ key, value })),
      },
      {
        // A year, preload-eligible. Only ever sent over HTTPS, so it is inert
        // on localhost and meaningful the moment a domain is attached.
        source: '/:path*',
        headers: [
          {
            key: 'strict-transport-security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
        ],
      },
    ]
  },
}

export default config
