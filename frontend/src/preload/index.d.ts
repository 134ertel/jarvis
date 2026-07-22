import type { JarvisApi } from "./index";

declare global {
  interface Window {
    jarvis: JarvisApi;
  }
}
