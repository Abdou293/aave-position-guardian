// The dashboard never talks to the blockchain and holds no secrets.
// It forwards /api/* to the backend (Fastify), so the browser sees ONE origin:
// no CORS, and the login cookie can be HttpOnly + SameSite=Strict.
import type { NextConfig } from 'next';

const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${API_BASE_URL}/api/:path*` },
      { source: '/healthz', destination: `${API_BASE_URL}/healthz` },
    ];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
