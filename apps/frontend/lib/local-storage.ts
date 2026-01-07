interface StorageValue<T> {
  value: T;
  expiresAt: number; // Unix timestamp
}

// SSR-safe check
const isClient = typeof window !== "undefined";

// 24 hours in milliseconds
const EXPIRY_DURATION = 24 * 60 * 60 * 1000;

export function setWithExpiry<T>(key: string, value: T): void {
  if (!isClient) return;

  const expiresAt = Date.now() + EXPIRY_DURATION;
  const storageValue: StorageValue<T> = { value, expiresAt };

  try {
    localStorage.setItem(key, JSON.stringify(storageValue));
  } catch (error) {
    console.warn(`Failed to save to localStorage: ${error}`);
  }
}

export function getWithExpiry<T>(key: string): T | null {
  if (!isClient) return null;

  try {
    const item = localStorage.getItem(key);
    if (!item) return null;

    const storageValue: StorageValue<T> = JSON.parse(item);

    // Check if expired
    if (Date.now() > storageValue.expiresAt) {
      localStorage.removeItem(key);
      return null;
    }

    return storageValue.value;
  } catch (error) {
    console.warn(`Failed to read from localStorage: ${error}`);
    return null;
  }
}

export function removeItem(key: string): void {
  if (!isClient) return;

  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`Failed to remove from localStorage: ${error}`);
  }
}
