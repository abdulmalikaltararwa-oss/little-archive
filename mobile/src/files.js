// Saving an export or backup from the phone: write it to the app's cache, then hand it to the system share sheet, where
// the person chooses Save to Files, AirDrop, a mail app and so on. The file holds their whole library in clear text, so it
// is removed again the next time the app starts and before the next export.
import { toBase64 } from './native-http.js';

const FOLDER = 'exports';

export function createFileSaver({ Filesystem, Directory, Share }) {
  const cleanup = () => Filesystem.rmdir({ path: FOLDER, directory: Directory.Cache, recursive: true }).catch(() => {});
  return {
    cleanup,
    async save(blob, filename) {
      const name = String(filename).replace(/[^\w.\- ]+/g, '_').slice(0, 100) || 'little-archive';
      await cleanup();
      const { uri } = await Filesystem.writeFile({ path: `${FOLDER}/${name}`, directory: Directory.Cache, data: toBase64(new Uint8Array(await blob.arrayBuffer())), recursive: true });
      await Share.share({ title: name, url: uri, dialogTitle: 'Save your download' });
    },
  };
}
