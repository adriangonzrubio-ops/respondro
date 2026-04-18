import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['unpdf'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/respondro.html',
        permanent: false,
      },
    ]
  },
  async rewrites() {
    return [
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/terms', destination: '/terms.html' },
      { source: '/pricing', destination: '/pricing.html' },
      { source: '/onboarding', destination: '/onboarding.html' },
    ]
  },
}

export default nextConfig