/** @type {import('next').NextConfig} */
const nextConfig = {
  // Retire only Halloween's public entry points. Other contest IDs and the
  // reusable operator/API remain available for future Community Voting events.
  async redirects() {
    return [
      {
        source: "/community-voting-round.html",
        has: [{ type: "query", key: "c", value: "94297d45-986a-423c-a1e9-9438bf1127c5" }],
        destination: "/halloween-2026.html",
        permanent: false,
      },
      {
        source: "/community-voting-round.html",
        missing: [{ type: "query", key: "c" }],
        destination: "/halloween-2026.html",
        permanent: false,
      },
      {
        source: "/community-voting-round-display.html",
        has: [{ type: "query", key: "c", value: "94297d45-986a-423c-a1e9-9438bf1127c5" }],
        destination: "/halloween-2026.html",
        permanent: false,
      },
    ];
  },
  // The redemption station page of the venue: never cached, never indexed, never framed, and it may only load its own script and talk to its own server.
  async headers() {
    return [
      {
        source: "/canje-the-pub.html",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          },
        ],
      },
      // The administration page of the station (it signs an administrator in, so it needs the sign-in script and the auth service, and has no
      // content-security-policy of its own, like the other administration pages): never cached, never indexed, never framed.
      {
        source: "/canje-admin.html",
        headers: [
          { key: "Cache-Control", value: "no-store, max-age=0" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
