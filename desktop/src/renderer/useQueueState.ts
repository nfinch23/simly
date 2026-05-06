import { useEffect, useState } from 'react';
import type { QueueState } from '../main/ipc';

const EMPTY: QueueState = {
  isRunning: false,
  characterKey: null,
  scenario: null,
  runStartedAt: null,
  lastCompletedAt: null,
  results: null,
};

/** Subscribe to queue state updates from the main process. */
export function useQueueState(): QueueState {
  const [state, setState] = useState<QueueState>(EMPTY);

  useEffect(() => {
    // Load current state immediately on mount
    void window.simly.getQueueState().then(setState);

    // Subscribe to push updates
    const unsubscribe = window.simly.onQueueStateChanged(setState);
    return unsubscribe;
  }, []);

  return state;
}
