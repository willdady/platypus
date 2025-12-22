import { ExternalLink } from "lucide-react";
import Link from "next/link";

const AboutPage = () => {
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown";

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">About</h1>
      <div className="mb-4">
        <p className="text-sm text-muted-foreground mb-2">Version</p>
        {version === "unknown" ? (
          <p className="font-mono">{version}</p>
        ) : (
          <Link
            href={`https://github.com/willdady/platypus/releases/tag/v${version}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono hover:underline inline-flex items-center gap-1"
          >
            {version} <ExternalLink className="size-4" />
          </Link>
        )}
      </div>
      <div className="mb-4">
        <p className="text-sm text-muted-foreground mb-2">GitHub</p>
        <Link
          href="https://github.com/willdady/platypus"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:underline inline-flex items-center gap-1"
        >
          willdady/platypus <ExternalLink className="size-4" />
        </Link>
      </div>
    </div>
  );
};

export default AboutPage;
