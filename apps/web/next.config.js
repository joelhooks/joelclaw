/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheComponents: true,
  typescript: {
    // Convex component types require transient dependency references
    // that Next.js type checker can't resolve. Convex handles its own typing.
    ignoreBuildErrors: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/docs",
        destination: "https://panda.tail7af24.ts.net/api/docs",
      },
      {
        source: "/api/docs/:path*",
        destination: "https://panda.tail7af24.ts.net/api/docs/:path*",
      },
    ];
  },
  async redirects() {
    return [
      {
        source: "/why-i-built-my-own-ai-system",
        destination: "/building-my-own-openclaw",
        permanent: true,
      },
      {
        source: "/building-a-personal-ai-from-scratch",
        destination: "/building-my-own-openclaw",
        permanent: true,
      },
      {
        source: "/taking-openclaw-apart",
        destination: "/building-my-own-openclaw",
        permanent: true,
      },
      {
        source: "/teaching-my-system-to-remember",
        destination: "/observation-pipeline-persistent-ai-memory",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
