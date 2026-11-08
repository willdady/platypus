import { User } from "lucide-react";

/**
 * The avatar-and-name cell the users and members tables lead with — the
 * loaded counterpart of `UserCellSkeleton`. The avatar is optional: a row
 * that never showed one keeps the placeholder icon.
 */
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
          // Avatar URLs come from an arbitrary OAuth/external host; not
          // routable through the Next image optimizer.
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
