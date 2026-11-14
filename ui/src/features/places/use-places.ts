// The library's places, as the screen reads them: one query (the filters), pages of up to 200, and an honest
// state for each way it can go: loading, ready, failed, locked. A result is tied to the query that made it, so
// changing a filter keeps showing the old places (dimmed) until the new ones arrive instead of flashing empty.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage } from '@web/utils.js';
import { useArchive } from '@/app/archive-context';
import { toast } from '@/app/ui-state';
import { isLocked } from '@/data/client';
import { placesApi, type PlaceKind, type PlaceRow } from './api';

export const PAGE_SIZE = 200;

export interface PlacesFilters {
  q: string;
  kind: PlaceKind | '';
  withCoordinates: boolean;
}

interface Result {
  key: string;
  status: 'ready' | 'error';
  places: PlaceRow[];
  total: number;
  error: string;
  locked: boolean;
}

export interface PlacesList {
  status: 'loading' | 'ready' | 'error';
  /** The query these places answer. It changes when the filters do and not when a page is added. */
  key: string;
  places: PlaceRow[];
  total: number;
  error: string;
  locked: boolean;
  /** The filters changed and the places shown are still the previous answer. */
  refreshing: boolean;
  loadingMore: boolean;
  loadMore(): void;
  reload(): void;
}

export function usePlaces(filters: PlacesFilters): PlacesList {
  const archive = useArchive();
  const api = useMemo(() => placesApi(archive.api), [archive]);
  const key = `${filters.kind}|${filters.withCoordinates ? 'xy' : 'all'}|${filters.q}`;
  const [result, setResult] = useState<Result | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const { kind, q, withCoordinates } = filters;
  useEffect(() => {
    let stale = false;
    api.list({ kind, q, withCoordinates, limit: PAGE_SIZE }).then(
      page => { if (!stale) setResult({ key, status: 'ready', places: page.places, total: page.total, error: '', locked: false }); },
      error => { if (!stale) setResult({ key, status: 'error', places: [], total: 0, error: errorMessage(error), locked: isLocked(error) }); },
    );
    return () => { stale = true; };
  }, [api, key, kind, q, withCoordinates, attempt]);

  const loadMore = useCallback(() => {
    if (!result || result.key !== key || result.status !== 'ready' || loadingMore || result.places.length >= result.total) return;
    setLoadingMore(true);
    api.list({ kind, q, withCoordinates, limit: PAGE_SIZE, offset: result.places.length }).then(
      page => {
        // An answer to a query that has since changed is dropped.
        setResult(current => {
          if (!current || current.key !== key) return current;
          const seen = new Set(current.places.map(place => place.id));
          return { ...current, places: [...current.places, ...page.places.filter(place => !seen.has(place.id))], total: page.total };
        });
      },
      error => toast(errorMessage(error), { error: true }),
    ).finally(() => setLoadingMore(false));
  }, [api, key, kind, q, withCoordinates, result, loadingMore]);

  const reload = useCallback(() => { setResult(null); setAttempt(value => value + 1); }, []);

  return {
    status: result ? result.status : 'loading',
    key: result?.key ?? key,
    places: result?.places ?? [],
    total: result?.total ?? 0,
    error: result?.error ?? '',
    locked: result?.locked ?? false,
    refreshing: Boolean(result) && result!.key !== key,
    loadingMore,
    loadMore,
    reload,
  };
}
