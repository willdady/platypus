import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyCard } from "@/components/empty-card";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <EmptyCard
        className="max-w-md"
        icon={<FileQuestion />}
        title="Page Not Found"
        description="The page you are looking for does not exist or has been moved."
        action={
          <Button asChild>
            <Link href="/">Go back home</Link>
          </Button>
        }
      />
    </div>
  );
}
