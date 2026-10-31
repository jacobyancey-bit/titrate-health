/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@titrate-health/shared"],
  async headers() {
    const apiOrigin =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
    const cspHeader = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      `connect-src 'self' ${apiOrigin}`,
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: cspHeader,
          },
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
