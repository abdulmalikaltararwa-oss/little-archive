// Renders whatever dialogs are open. Heavy ones are split out of the first load: nobody needs the settings
// screen to see their library.
import { lazy, Suspense } from 'react';
import { useDialogs, type OpenDialog } from '@/app/ui-state';
import { BrowseSheet } from '../shell/shell';
import { BulkDialog, CollectionDialog, CopyTextDialog, DeleteAccountDialog, SaveLinkDialog } from './basic';

const SettingsDialog = lazy(() => import('./settings').then(module => ({ default: module.SettingsDialog })));
const ActivityDialog = lazy(() => import('./activity').then(module => ({ default: module.ActivityDialog })));
const OrganizeDialog = lazy(() => import('./organize').then(module => ({ default: module.OrganizeDialog })));
const ImportDialog = lazy(() => import('./import').then(module => ({ default: module.ImportDialog })));
const CommandPalette = lazy(() => import('../palette/palette').then(module => ({ default: module.CommandPalette })));

function One({ spec }: { spec: OpenDialog }) {
  const closeDialog = useDialogs(state => state.close);
  const close = () => closeDialog(spec.id);
  switch (spec.kind) {
    case 'save-link': return <SaveLinkDialog spec={spec} close={close} />;
    case 'collection': return <CollectionDialog spec={spec} close={close} />;
    case 'bulk': return <BulkDialog spec={spec} close={close} />;
    case 'copy-text': return <CopyTextDialog spec={spec} close={close} />;
    case 'delete-account': return <DeleteAccountDialog spec={spec} close={close} />;
    case 'browse': return <BrowseSheet spec={spec} close={close} />;
    case 'organize': return <OrganizeDialog spec={spec} close={close} />;
    case 'import': return <ImportDialog spec={spec} close={close} />;
    case 'activity': return <ActivityDialog spec={spec} close={close} />;
    case 'settings': return <SettingsDialog spec={spec} close={close} />;
    case 'palette': return <CommandPalette spec={spec} close={close} />;
  }
}

export function DialogHost() {
  const stack = useDialogs(state => state.stack);
  return (
    <Suspense fallback={null}>
      {stack.map(spec => <One key={spec.id} spec={spec} />)}
    </Suspense>
  );
}
