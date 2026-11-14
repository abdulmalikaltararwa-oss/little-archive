// Seams for the features arriving in the next wave. Their server contracts are being written in parallel,
// so nothing here guesses at them: each type is a named placeholder with no readable members, which makes
// it impossible to build against a shape that does not exist yet. When a contract lands, replace the
// placeholder with the real type and the compiler will point at every screen that needs filling in.

declare const pending: unique symbol;

/** A contract that has not been defined yet. It has no members on purpose. */
export interface Pending<Name extends string> {
  readonly [pending]: Name;
}

export type RecipeCard = Pending<'recipe-card'>;
export type CookModeSession = Pending<'cook-mode'>;
export type SavedPlaces = Pending<'places-map'>;
export type ArchiveAnswer = Pending<'ask-your-archive'>;
export type GuidedExportImport = Pending<'guided-export-import'>;
export type UnlockPurchase = Pending<'one-time-unlock'>;

/** What each placeholder screen will be given once its feature exists. */
export interface SeamContracts {
  recipes: { card: RecipeCard; cookMode: CookModeSession };
  places: { places: SavedPlaces };
  ask: { answer: ArchiveAnswer };
  'guided-import': { flow: GuidedExportImport };
  unlock: { purchase: UnlockPurchase };
}
