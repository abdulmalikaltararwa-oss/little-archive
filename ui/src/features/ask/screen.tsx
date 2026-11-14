// Placeholder until the real screen lands in this file. The address, the navigation entry and the lazy
// loading are already wired (src/features/screens.tsx); only this component changes.
import { SeamScreen } from '../seams/seam-screen';
import type { FeatureScreenProps } from '../screens';

export default function AskScreen({ demo }: FeatureScreenProps) {
  return <SeamScreen screen="ask" demo={demo} />;
}
