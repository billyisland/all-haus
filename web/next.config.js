/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // All 7 pages that use useSearchParams() are fully client-side rendered.
    // This flag prevents Next.js from requiring a <Suspense> boundary during
    // static export, which is unnecessary for CSR-only pages.
    missingSuspenseWithCSRBailout: false,
  },
  images: {
    remotePatterns: [
      {
        // Blossom media server
        protocol: 'https',
        hostname: '*.blossom.pub',
      },
    ],
  },
  async rewrites() {
    return [
      {
        // Proxy API requests to the gateway in dev
        source: '/api/:path*',
        destination: `${process.env.GATEWAY_URL ?? 'http://localhost:3000'}/api/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
