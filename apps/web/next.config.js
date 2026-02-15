/** @type {import('next').NextConfig} */
const nextConfig = {
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
    ];
  },
};

export default nextConfig;
