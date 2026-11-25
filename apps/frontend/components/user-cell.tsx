import { User } from "lucide-react";

export function UserCell({
  name,
  email,
  image,
}: {
  name: string;
  email: string;
  image?: string | null;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="size-8 shrink-0 overflow-hidden rounded-full bg-muted flex items-center justify-center">
        {image ? (
          // why: an avatar URL is an arbitrary host, not routable through the optimizer
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt={name}
            className="size-full object-cover"
            width={32}
            height={32}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <User className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex flex-col">
        <span className="font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">{email}</span>
      </div>
    </div>
  );
}
