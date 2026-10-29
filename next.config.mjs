/** @type {import('next').NextConfig} */
const nextConfig = {
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
