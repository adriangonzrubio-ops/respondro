import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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