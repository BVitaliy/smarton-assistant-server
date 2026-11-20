import { App, getApps, initializeApp } from "firebase-admin/app";

/** Один екземпляр Firebase Admin на інстанс функції. */
export function adminApp(): App {
  return getApps()[0] ?? initializeApp();
}
