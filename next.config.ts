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
}

export default nextConfig