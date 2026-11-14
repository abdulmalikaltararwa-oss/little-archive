import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from 'cn';
import { Slot } from 'radix-ui';

// shadcn/ui Button, reshaped for Little Archive: pills, a soft press, and a 44px target on touch.
const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-2 rounded-full font-semibold whitespace-nowrap select-none',
    'transition-[background-color,color,box-shadow,transform,border-color] duration-200 ease-out outline-none',
    'active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: 'bg-sage text-on-sage shadow-[0_10px_18px_-10px_var(--sage),inset_0_1px_0_#ffffff33] hov:bg-sage-deep hov:-translate-y-px',
        soft: 'bg-sage-pale text-sage hov:bg-sage-pale/70 dark:text-sage-deep',
        outline: 'border border-line-strong bg-card text-ink hov:bg-card-2',
        ghost: 'text-ink hov:bg-card-2',
        danger: 'border border-danger/30 bg-danger-pale text-danger hov:bg-danger hov:text-card',
        'danger-ghost': 'text-danger hov:bg-danger-pale',
        link: 'h-auto rounded-sm p-0 text-sage underline-offset-4 hov:underline',
      },
      size: {
        sm: 'h-8.5 px-3.5 text-xs coarse:h-11',
        md: 'h-10.5 px-4.5 text-sm coarse:h-11',
        lg: 'h-12 px-6 text-base',
        icon: 'size-9.5 text-ink-soft hov:text-ink coarse:size-11',
        'icon-sm': 'size-8 text-ink-soft hov:text-ink',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
