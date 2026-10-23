import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const backend = process.env.API_INTERNAL_URL || "http://api:8000";
    return [{ source: "/api/:path*", destination: backend + "/api/:path*" }];
  },
};

export default nextConfig;
