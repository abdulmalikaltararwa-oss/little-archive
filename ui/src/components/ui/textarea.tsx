import * as React from 'react';
import { cn } from 'cn';
import { fieldSurface } from './input';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn(fieldSurface, 'min-h-24 resize-y py-2.5 leading-relaxed', className)} {...props} />;
}

export { Textarea };
