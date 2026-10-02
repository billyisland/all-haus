/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      {
        // /community-guidelines is an ADDRESS, not a document.
        //
        // The Writer Agreement (15.5) promises "published content standards",
        // and the retired footer linked a /community-guidelines page. Those
        // standards exist and are published: they are clause 4 of the Terms of
        // Service, at /terms. What was missing was never the text, it was an
        // address for it — so this is the address, and there is no second copy
        // of a public contract free to disagree with the first.
        //
        // NO ANCHOR, deliberately: the generated legal HTML carries no heading
        // ids (web/scripts/gen-legal-texts.ts sanitises to a narrow tag set),
        // so /terms#content-rules would be a link that silently does nothing.
        // Giving the headings ids is a change to all four published documents'
        // markup and is not worth it for one alias.
        //
        // 307 AND NOT 308, which is the only judgement here. A permanent
        // redirect is cached by the browser effectively forever, so if the
        // operator ever does decide to give the content standards their own
        // page, every visitor who had followed this alias would be unable to
        // reach it. The address is new; nothing depends on it being permanent;
        // and a temporary redirect costs nothing at all (search engines follow
        // it either way) while keeping that door open.
        source: '/community-guidelines',
        destination: '/terms',
        permanent: false,
      },
    ]
  },

  async rewrites() {
    return [
      {
        // Proxy API requests to the gateway in dev
        source: '/api/:path*',
        destination: `${process.env.GATEWAY_URL ?? 'http://localhost:3000'}/api/:path*`,
      },
    ]
  },
}

module.exports = nextConfig
