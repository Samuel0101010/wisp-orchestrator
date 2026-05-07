import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { ComponentProps } from 'react';
import { TeamRoleCard } from '@/components/TeamRoleCard';

type Props = Omit<ComponentProps<typeof TeamRoleCard>, 'dragHandleProps'> & { id: string };

/**
 * Wraps TeamRoleCard with @dnd-kit's `useSortable` so it can be reordered via
 * mouse drag, touch drag, or keyboard (Tab to drag-handle → Space to grab →
 * arrow keys to move → Space to drop). Only the grip button is the drag
 * activator; the rest of the card stays interactive (typing into inputs,
 * toggling the tool picker, opening dialogs).
 *
 * Keep the underlying TeamRoleCard pure/dumb — that lets it stay testable
 * without a DndContext provider in the unit-test harness.
 */
export function SortableTeamRoleCard({ id, ...rest }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    // Lift the dragged card above siblings so its shadow doesn't get clipped
    // by neighboring grid items during the move animation.
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} data-sortable-id={id}>
      <TeamRoleCard
        {...rest}
        dragHandleProps={{
          ref: setActivatorNodeRef,
          ...attributes,
          ...listeners,
        }}
      />
    </div>
  );
}
