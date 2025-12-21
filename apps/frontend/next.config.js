/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Disable ESLint during build to speed up and avoid hanging
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Disable TypeScript type checking during build (types are checked in CI)
  typescript: {
    ignoreBuildErrors: false, // Keep type checking, but allow build to continue
  },
  rewrites() {
    // Use environment variable for backend URL, fallback to localhost for development
    // Make it synchronous to avoid hanging during build/dev server startup
    const backendUrl = process.env.BACKEND_URL || 
      (process.env.NEXT_PUBLIC_API_URL ? process.env.NEXT_PUBLIC_API_URL.replace('/api', '') : null) || 
      'http://localhost:3001';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
  headers() {
    // Make it synchronous to avoid hanging during build/dev server startup
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Robots-Tag',
            value: 'noindex, nofollow, noarchive, nosnippet, noimageindex',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;

