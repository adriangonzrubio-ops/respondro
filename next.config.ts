import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  serverExternalPackages: ['pdf-parse'],
  async redirects() {
    return [
      {
        source: '/',
        destination: '/respondro.html',
        permanent: false,
      },
    ]
  },
}

export default nextConfig