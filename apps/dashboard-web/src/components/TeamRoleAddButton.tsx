import { Button } from '@/components/ui/button';

interface Props {
  onAdd: () => void;
  disabled: boolean;
  count: number;
  max: number;
}

export function TeamRoleAddButton({ onAdd, disabled, count, max }: Props) {
  return (
    <Button
      variant="outline"
      onClick={onAdd}
      disabled={disabled}
      data-testid="add-role"
      className="w-full"
    >
      + Add role ({count}/{max})
    </Button>
  );
}
