import { generateStaticParamsFor, importPage } from "nextra/pages";
import type { FC } from "react";
import { openGraph, twitter } from "../layout";
import { useMDXComponents as getMDXComponents } from "../../mdx-components";

export const generateStaticParams = generateStaticParamsFor("mdxPath");

type PageProps = Readonly<{
  params: Promise<{
    mdxPath: string[];
  }>;
}>;

export async function generateMetadata(props: PageProps) {
  const params = await props.params;
  const { metadata } = await importPage(params.mdxPath);
  // Per-page canonical URL. Resolves against `metadataBase`
  // (https://docs.platypus.chat); index page -> "/", others -> "/<path>".
  const canonicalPath = `/${(params.mdxPath ?? []).join("/")}`;
  metadata.alternates = { ...metadata.alternates, canonical: canonicalPath };
  // Nextra only sets the plain `title` from frontmatter. Mirror it into
  // openGraph/twitter so link previews show the page title (the parent
  // layout's `%s | Platypus Docs` template then applies to og:title too).
  // Spread the layout's shared bases first: Next.js OVERWRITES (does not
  // deep-merge) openGraph/twitter across segments, so without these the
  // og:image and Twitter card from the layout would be dropped.
  const pageTitle = metadata.title;
  if (typeof pageTitle === "string") {
    metadata.openGraph = {
      ...openGraph,
      ...metadata.openGraph,
      title: pageTitle,
    };
    metadata.twitter = { ...twitter, ...metadata.twitter, title: pageTitle };
  }
  return metadata;
}

const Wrapper = getMDXComponents().wrapper;

const Page: FC<PageProps> = async (props) => {
  const params = await props.params;
  const result = await importPage(params.mdxPath);
  const { default: MDXContent, toc, metadata, sourceCode } = result;
  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
};

export default Page;
