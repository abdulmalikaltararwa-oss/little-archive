// Review scaffolding for shots-places.mjs (see places-harness.html). It boots the same archive the app does, then
// draws one save's places section inside a card shaped like the detail panel: ?item=<id>.
import '../src/styles/index.css';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { ArchiveProvider } from '../src/app/archive-context';
import { useTheme } from '../src/app/theme';
import { ConfirmHost } from '../src/components/confirm';
import { Island } from '../src/components/island';
import { createArchive } from '../src/data/archive';
import { createBackend } from '../src/data/backend';
import type { Item } from '../src/data/types';
import { PlacesEntry } from '../src/features/places/detail-entry';
import { Whisper } from '../src/components/field';

const backend = await createBackend();
useTheme.getState().init(backend.remembers);
const archive = createArchive({ backend });
await archive.boot();

// A scaffold, not a module: nothing imports it, so fast refresh has nothing to protect.
// eslint-disable-next-line react-refresh/only-export-components
function Harness() {
  const [item, setItem] = useState<Item | null>(null);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('item') ?? '';
    void archive.api.item(id).then(setItem);
  }, []);
  return (
    <ArchiveProvider archive={archive}>
      <MotionConfig reducedMotion="user">
        <div className="mx-auto min-h-dvh max-w-[540px] bg-card px-5 py-6 sm:px-7">
          {item ? (
            <>
              <Whisper>a closer look</Whisper>
              <h2 dir="auto" className="display mt-3 text-[1.75rem] leading-tight text-ink">{item.title}</h2>
              <PlacesEntry item={item} />
            </>
          ) : null}
        </div>
        <ConfirmHost />
        <Island />
      </MotionConfig>
    </ArchiveProvider>
  );
}

createRoot(document.getElementById('app')!).render(<Harness />);
