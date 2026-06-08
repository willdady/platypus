import nextra from "nextra";

const withNextra = nextra({
  // Built-in Pagefind search; skip indexing fenced code blocks.
  search: {
    codeblocks: false,
  },
});

// Static satellite (ADR-0011): export to `out/` so the docs can be served from
// a CDN with no runtime. `images.unoptimized` is required for `output: 'export'`.
export default withNextra({
  output: "export",
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
});
