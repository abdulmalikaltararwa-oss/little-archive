import * as React from 'react';
import { cn } from 'cn';
import { Switch as SwitchPrimitive } from 'radix-ui';

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer hit-44 inline-flex h-7 w-12 shrink-0 items-center rounded-full border-[1.5px] border-line-strong bg-card-3 p-0.5 transition-colors outline-none',
        'focus-visible:ring-4 focus-visible:ring-sage/20 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-sage data-[state=checked]:bg-sage',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-5 rounded-full bg-card shadow-xs transition-transform duration-200 ease-spring data-[state=checked]:translate-x-5 data-[state=checked]:bg-on-sage rtl:data-[state=checked]:-translate-x-5"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
