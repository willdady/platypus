import { generateStaticParamsFor, importPage } from "nextra/pages";
import type { FC } from "react";
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
  // Nextra only sets the plain `title` from frontmatter. Mirror it into
  // openGraph/twitter so link previews show the page title (the parent
  // layout's `%s | Platypus Docs` template then applies to og:title too).
  const pageTitle = metadata.title;
  if (typeof pageTitle === "string") {
    metadata.openGraph = { ...metadata.openGraph, title: pageTitle };
    metadata.twitter = { ...metadata.twitter, title: pageTitle };
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
