import {
  AvatarSkeleton,
  CollapsibleSkeleton,
  FieldSkeleton,
  FooterSkeleton,
  FormSkeletonGroup,
  FormSkeletonSet,
  SwitchCardSkeleton,
  TextareaSkeleton,
} from "@/components/form-skeleton";

/**
 * The agent form's loading placeholder, block for block: the avatar picker,
 * the field group, the switch cards and the closed Advanced settings row.
 * Its own module so the agent pages' route-level `loading.tsx`, shown while
 * the server fetches the tool sets, needn't pull in the whole form.
 */
export const AgentFormSkeleton = ({
  className,
  editing = false,
  tools = true,
}: {
  className?: string;
  /** An edit form: taller Instructions, and a Delete button. */
  editing?: boolean;
  /** Whether the Tools card shows (there are tool sets to pick from). */
  tools?: boolean;
}) => (
  <div className={className}>
    <FormSkeletonSet>
      <AvatarSkeleton />
      <FormSkeletonGroup>
        <FieldSkeleton />
        <TextareaSkeleton counter />
        <FieldSkeleton description={1} />
        <TextareaSkeleton
          heightClassName={editing ? "h-52" : "h-16"}
          description={2}
        />
        <FieldSkeleton />
        <FieldSkeleton className="w-1/2" description={1} />
      </FormSkeletonGroup>
      {tools && <SwitchCardSkeleton rows={4} />}
      <SwitchCardSkeleton className="mb-6" rows={2} />
      <SwitchCardSkeleton className="mb-6" rows={2} description />
      <CollapsibleSkeleton />
    </FormSkeletonSet>
    <FooterSkeleton buttons={editing ? 2 : 1} />
  </div>
);
