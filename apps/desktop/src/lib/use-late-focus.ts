import { useEffect, useRef } from 'react';

/**
 * Focuses a field shortly after it appears. A menu that opened the field takes focus back
 * as it closes, so focusing on mount would be undone. `settled` turns true once the field
 * has focus for good, for callers that treat a later blur as "cancel".
 */
export function useLateFocus<T extends HTMLInputElement>() {
  const field = useRef<T>(null);
  const settled = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      settled.current = true;
      field.current?.focus();
      field.current?.select();
    }, 50);
    return () => clearTimeout(timer);
  }, []);
  return { field, settled };
}
