import type { SimlyBridge } from '../preload/index';

declare global {
  interface Window {
    simly: SimlyBridge;
  }
}
