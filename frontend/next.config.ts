import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:3001/api/:path*',
      },
      {
        source: '/uploads/:path*',
        destination: 'http://127.0.0.1:3001/uploads/:path*',
      },
      {
        source: '/upload',
        destination: 'http://127.0.0.1:3001/upload',
      },
    ];
  },
};

export default nextConfig;
