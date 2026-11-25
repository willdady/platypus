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

export function AgentFormSkeleton({
  className,
  editing = false,
  tools = true,
}: {
  className?: string;
  editing?: boolean;
  tools?: boolean;
}) {
  return (
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
}
