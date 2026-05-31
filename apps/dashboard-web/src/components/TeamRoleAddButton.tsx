import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

interface Props {
  onAdd: () => void;
  disabled: boolean;
  count: number;
  max: number;
}

export function TeamRoleAddButton({ onAdd, disabled, count, max }: Props) {
  const { t } = useTranslation();
  return (
    <Button
      variant="outline"
      onClick={onAdd}
      disabled={disabled}
      data-testid="add-role"
      className="w-full"
    >
      {t('teamBuilder.addRole', '+ Add role ({{count}}/{{max}})', { count, max })}
    </Button>
  );
}
