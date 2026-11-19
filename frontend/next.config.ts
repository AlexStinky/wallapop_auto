import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const backend = (process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001').replace(/\/+$/, '');
    return [
      {
        source: '/api/:path*',
        destination: `${backend}/api/:path*`,
      },
      {
        source: '/uploads/:path*',
        destination: `${backend}/uploads/:path*`,
      },
      {
        source: '/upload',
        destination: `${backend}/upload`,
      },
    ];
  },
  experimental: {
    proxyClientMaxBodySize: '100mb',
  },
};

export default nextConfig;
