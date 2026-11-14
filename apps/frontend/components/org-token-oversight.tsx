import { TableCell } from "@/components/ui/table";
import {
  BadgeSkeleton,
  IconButtonSkeleton,
  InlineSkeleton,
  TableSkeleton,
} from "@/components/list-skeletons";

/**
 * What the two Org Admin oversight tables share (#1851): the columns, the
 * loading placeholder and the Workspace/Owner cell. Their revoke hook lives
 * in `hooks/use-org-revoke`. The components stay separate — A2A's nested
 * token rows differ enough that one generic table would be harder to read.
 */

/** The loaded table's width, from its widest row. */
export const OVERSIGHT_TABLE_CLASS = "min-w-[720px]";

/** The columns both tables show, with their own subject first. */
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

/** The loading placeholder for either oversight table, headings and all. */
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

/** Where the row lives and whose it is: the Owner, not the Admin. */
export function WorkspaceOwnerCell({
  workspaceName,
  ownerName,
}: {
  workspaceName: string;
  ownerName: string;
}) {
  return (
    <TableCell>
      {/* The Owner, not the Admin: the run acts as them and a revoke notifies
          them. */}
      <div className="flex flex-col">
        <span>{workspaceName}</span>
        <span className="text-xs text-muted-foreground">{ownerName}</span>
      </div>
    </TableCell>
  );
}
