import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['unpdf'],
  async rewrites() {
    return [
      { source: '/', destination: '/index.html' },
      { source: '/login', destination: '/respondro.html' },
      { source: '/dashboard', destination: '/respondro.html' },
      { source: '/privacy', destination: '/privacy.html' },
      { source: '/terms', destination: '/terms.html' },
      { source: '/pricing', destination: '/pricing.html' },
      { source: '/onboarding', destination: '/onboarding.html' },
    ]
  },
}

export default nextConfig