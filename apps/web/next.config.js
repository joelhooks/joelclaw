/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Convex component types require transient dependency references
    // that Next.js type checker can't resolve. Convex handles its own typing.
    ignoreBuildErrors: true,
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
