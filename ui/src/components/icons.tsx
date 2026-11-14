import type { SVGProps } from 'react';
import { Globe } from 'lucide-react';
import type { Platform } from '@/data/types';

// Lucide no longer ships brand marks. These two outlines are Little Archive's own, carried over from the
// buildless interface (web/app.js).
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export function InstagramIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r=".7" />
    </svg>
  );
}

export function TikTokIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M14 3v12.5a4.5 4.5 0 1 1-4.5-4.5M14 3c1 4 3 5 7 5v4c-3 0-5-1-7-3" />
    </svg>
  );
}

export function PlatformIcon({ platform, ...props }: { platform: Platform | string } & SVGProps<SVGSVGElement>) {
  if (platform === 'instagram') return <InstagramIcon {...props} />;
  if (platform === 'tiktok') return <TikTokIcon {...props} />;
  return <Globe aria-hidden="true" strokeWidth={1.7} {...props} />;
}
