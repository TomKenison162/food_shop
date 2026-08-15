const withPWA = require("@ducanh2912/next-pwa").default({
  dest: "public",
  cacheOnFrontEndNav: true,
  aggressiveFrontEndNavCaching: true,
  reloadOnOnline: true,
  disable: process.env.NODE_ENV === "development",
  workboxOptions: {
    disableDevLogs: true,
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // PGlite (local-dev-only WASM Postgres) resolves its wasm/data assets via
  // import.meta.url at runtime; webpack's bundling breaks that. Keep it
  // external so Node loads it natively instead.
  experimental: {
    serverComponentsExternalPackages: ["@electric-sql/pglite"],
  },
};

module.exports = withPWA(nextConfig);
