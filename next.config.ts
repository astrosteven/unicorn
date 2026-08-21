import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  basePath: "/unicorn",
  images: { unoptimized: true },
};

export default nextConfig;
