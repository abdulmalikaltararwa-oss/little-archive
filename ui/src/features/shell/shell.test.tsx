import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useKeyboardUp } from './shell';

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-keyboard');
});

describe('the phone app’s keyboard mark', () => {
  it('is off where nothing sets it: a browser, and the app on Android', () => {
    const { result } = renderHook(() => useKeyboardUp());
    expect(result.current).toBe(false);
  });

  it('follows data-keyboard on the root element, which the iOS app sets while its keyboard is up', async () => {
    const { result } = renderHook(() => useKeyboardUp());
    act(() => { document.documentElement.toggleAttribute('data-keyboard', true); });
    await waitFor(() => expect(result.current).toBe(true));
    act(() => { document.documentElement.toggleAttribute('data-keyboard', false); });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is already on for a screen drawn while the keyboard is up', () => {
    document.documentElement.toggleAttribute('data-keyboard', true);
    const { result } = renderHook(() => useKeyboardUp());
    expect(result.current).toBe(true);
  });
});
