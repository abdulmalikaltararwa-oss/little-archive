// One interface, three places the library can live.
//
//   browser  a self-hosted server on the page's own origin; the owner's cookie and a CSRF token
//   native   the iOS/Android app: a bearer token the shell owns, sent through the platform's HTTP client
//   demo     synthetic records in memory; no request ever leaves the page
//
// Everything above this file (the client, the store, every screen) talks to a Backend and never asks which
// one it is, except through the capability fields below.
import type { ShareFields, StoreProof } from './types';

export type BackendKind = 'browser' | 'native' | 'demo';
export type ServerMode = 'self-hosted' | 'hosted';

/** How a stored thumbnail reaches an <img>: a same-origin address, or a fetch the image element is attached to. */
export type ThumbnailSource =
  | { type: 'url'; src: string }
  | { type: 'attach'; attach: (image: HTMLImageElement) => void };

export interface DeviceAccount {
  email?: string | null;
  signOut(options?: { deleted?: boolean }): Promise<void> | void;
  switchServer(): Promise<void> | void;
}

/**
 * The store's purchase sheet, which only the phone app has. The interface never sees a card or a price it did
 * not get from the store: it asks the app to buy or restore, receives the store's signed proof, and hands that
 * to the server (POST /api/purchases/apple|google), which is the only thing that can unlock an account.
 *
 * The app provides it as `purchases` on globalThis.__littleArchiveNative (mobile/src/purchases.js), only for a hosted
 * account: on a self-hosted server it is absent, nothing is for sale and nothing is gated. Without it,
 * `Backend.purchases` is null and the unlock screen says the purchase happens in the app.
 *
 * The store holds a purchase open until the app says it has been delivered (Apple: the transaction is unfinished;
 * Google: an unacknowledged purchase is refunded after three days). So the order is: the store hands over a proof,
 * the interface gives it to the server, the server answers, and only then does `settled` tell the store. A proof the
 * server could not be asked about stays open and is offered again at the next start.
 */
export interface PurchaseBridge {
  /** Which store this build sells through. */
  readonly provider: 'apple' | 'google';
  /**
   * Opens the store's sheet for the one-time unlock. `accountId` is the hosted account's UUID, which the app must
   * bind to the purchase (Apple: appAccountToken; Google: the obfuscated account id, lowercase hex SHA-256 of it).
   * Resolves with the proof; with null when the person closed the sheet without buying; or with 'pending' when the
   * store is holding the purchase back (Ask to Buy, or a payment that has not cleared) and there is nothing to send yet.
   */
  buy(options: { accountId: string }): Promise<StoreProof | null | 'pending'>;
  /** Asks the store for unlocks this store account already bought. An empty list means there is nothing to restore. */
  restore(): Promise<StoreProof[]>;
  /** The store's own localized price for the unlock, when it can give one. */
  price?(): Promise<string | null>;
  /** The server's answer to a proof this bridge handed out, so the store can be told the purchase was delivered. Never throws into the caller. */
  settled?(proof: StoreProof, answer: PurchaseAnswer): Promise<void>;
  /** Called when the app itself, without a button press, got an unlock accepted (an approval that arrived later, a purchase left from the last start). */
  onUnlocked?(listener: () => void): () => void;
}

/** What the server said: it unlocked the account (Google: `acknowledged` says whether it also acknowledged the purchase), or it refused the proof for good. */
export type PurchaseAnswer = { outcome: 'unlocked'; acknowledged?: boolean } | { outcome: 'refused' };

export interface Backend {
  readonly kind: BackendKind;
  readonly mode: ServerMode;
  /** The address shown to the owner as "this server". */
  readonly serverUrl: string;
  /** Sends one request. `path` is absolute and begins with /api/. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Turns an item's `thumbnail_url` into something an <img> can show, or null when it is not a stored thumbnail. */
  thumbnail(value: string | null | undefined): ThumbnailSource | null;
  /** Hands a prepared download to the person: a browser download, or the phone's share sheet. */
  saveFile(blob: Blob, filename: string): Promise<'downloaded' | 'shared'>;
  /** True where the owner signs in with the instance password in this page. */
  readonly passwordLogin: boolean;
  /** True where the server sets a cookie and expects the CSRF token on writes. */
  readonly csrf: boolean;
  /** Called when the server refuses the credential for good. Returns true if the backend took over (the app's shell does). */
  signedOut(message: string): boolean;
  /** Present only inside the app: sign out, switch server, and the account's email. */
  readonly account: DeviceAccount | null;
  /** A link shared from another app before this one opened. */
  readonly initialShare: ShareFields | null;
  /** Links shared while the app is open. Returns an unsubscribe function. */
  onShare(listener: (fields: ShareFields) => void): () => void;
  /** False where preferences must not outlive the page (the demo). */
  readonly remembers: boolean;
  /** True where the server can take file uploads, tokens, backups and AI jobs. */
  readonly real: boolean;
  /** The store's purchase sheet, present only inside the app once it provides one. */
  readonly purchases: PurchaseBridge | null;
}

/** What mobile/src/boot.js defines before the interface loads. Documented in docs/mobile-app.md. */
export interface NativeBridge {
  platform: string;
  mode: ServerMode;
  serverUrl: string;
  initialShare: ShareFields | null;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  localAsset(value: unknown): string | null;
  attachImage(image: HTMLImageElement, path: string): void;
  onShare(listener: (fields: ShareFields) => void): (() => void) | void;
  saveFile(blob: Blob, filename: string): Promise<void>;
  signedOut(message?: string): Promise<void> | void;
  account: DeviceAccount;
  /** Optional: the app's store purchase sheet. See PurchaseBridge. */
  purchases?: PurchaseBridge;
}

declare global {
  var __littleArchiveNative: NativeBridge | undefined;
}

export function isDemoPage(root: HTMLElement = document.documentElement): boolean {
  return root.dataset.demo === 'true';
}

/** Chooses the backend for this page. The demo never looks at the native bridge, and the bridge wins over the cookie. */
export async function createBackend(): Promise<Backend> {
  if (isDemoPage()) return (await import('./backends/demo')).createDemoBackend();
  const bridge = globalThis.__littleArchiveNative;
  if (bridge) return (await import('./backends/native')).createNativeBackend(bridge);
  return (await import('./backends/browser')).createBrowserBackend();
}
