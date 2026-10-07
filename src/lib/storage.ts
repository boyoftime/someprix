/** Small settings kept between launches. Storage can be unavailable; then nothing is remembered. */

export function remembered(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered; it still applies until the app closes.
  }
}

export function forget(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to forget.
  }
}
