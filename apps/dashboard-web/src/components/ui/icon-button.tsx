import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: screen-reader label AND tooltip content. Always a translated string. */
  label: string;
  /** The lucide icon (or any node). */
  icon: ReactNode;
  /** Forwarded to the underlying Button. */
  variant?: 'default' | 'ghost' | 'outline' | 'secondary' | 'destructive';
  size?: 'sm' | 'default' | 'icon';
  className?: string;
}

/**
 * Icon-only button that pairs a Tooltip with an aria-label. Two-line API
 * makes a11y the path of least resistance: you can't add an icon button
 * without remembering the label.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, icon, variant = 'ghost', size = 'icon', className, ...props }, ref) => {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={ref}
            variant={variant}
            size={size}
            aria-label={label}
            className={cn(className)}
            {...props}
          >
            {icon}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  },
);
IconButton.displayName = 'IconButton';
