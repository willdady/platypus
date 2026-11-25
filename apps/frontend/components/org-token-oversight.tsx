import { TableCell } from "@/components/ui/table";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  InlineSkeleton,
  TableSkeleton,
} from "@/components/list-skeletons";

// why: columns and skeleton shared, tables separate — A2A's nested token rows differ
export const OVERSIGHT_TABLE_CLASS = "min-w-[720px]";

export function oversightColumns(firstHeader: string) {
  return [
    firstHeader,
    "Workspace",
    "Created",
    "Expires",
    "Last used",
    "Last rejected",
  ] as const;
}

export function OversightTableSkeleton({
  firstHeader,
}: {
  firstHeader: string;
}) {
  return (
    <TableSkeleton
      tableClassName={OVERSIGHT_TABLE_CLASS}
      columns={[
        ...oversightColumns(firstHeader).map((header) => ({
          header,
          cell:
            header === "Expires" ? (
              <BadgeSkeleton className="w-16" />
            ) : (
              <InlineSkeleton className="w-20" />
            ),
        })),
        {
          header: "Actions",
          className: "text-right",
          cell: (
            <div className="flex justify-end">
              <IconButtonSkeleton />
            </div>
          ),
        },
      ]}
    />
  );
}

export function WorkspaceOwnerCell({
  workspaceName,
  ownerName,
}: {
  workspaceName: string;
  ownerName: string;
}) {
  // why: the Owner, not the Admin — the run acts as them and a revoke notifies them
  return (
    <TableCell>
      <div className="flex flex-col">
        <span>{workspaceName}</span>
        <span className="text-xs text-muted-foreground">{ownerName}</span>
      </div>
    </TableCell>
  );
}
