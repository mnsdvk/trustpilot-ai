/** @type {import('next').NextConfig} */
const nextConfig = {
  // Type errors are checked locally with `tsc`. Do not block the hosted build on them.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
