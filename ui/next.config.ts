import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const backend = process.env.VIGIL_BACKEND_URL || "http://localhost:3000";
    return [
      { source: "/api/vigil/:path*", destination: `${backend}/api/vigil/:path*` },
      { source: "/webhook/:path*", destination: `${backend}/webhook/:path*` },
    ];
  },
};

export default nextConfig;
