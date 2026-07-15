export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export type TokenSnapshot = {
  token: string | null;
  generation: number;
};

type TokenListener = (snapshot: TokenSnapshot) => void;

let token: string | null = null;
let initialized = false;
let generation = 0;
const listeners = new Set<TokenListener>();

const readStorage = () => {
  if (typeof localStorage === 'undefined') return null;
  return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
};

const writeStorage = (nextToken: string | null) => {
  if (typeof localStorage === 'undefined') return;
  if (nextToken) localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, nextToken);
  else localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

const ensureInitialized = () => {
  if (initialized) return;
  token = readStorage();
  initialized = true;
};

const notify = () => {
  const snapshot = getAuthTokenSnapshot();
  for (const listener of listeners) listener(snapshot);
};

export const getAuthTokenSnapshot = (): TokenSnapshot => {
  ensureInitialized();
  return { token, generation };
};

export const getAuthToken = (): string | null => getAuthTokenSnapshot().token;

export const isCurrentAuthTokenSnapshot = (snapshot: TokenSnapshot): boolean => {
  const current = getAuthTokenSnapshot();
  return current.generation === snapshot.generation && current.token === snapshot.token;
};

export const setAuthToken = (nextToken: string): TokenSnapshot => {
  ensureInitialized();
  if (token === nextToken) return getAuthTokenSnapshot();
  token = nextToken;
  generation += 1;
  writeStorage(token);
  notify();
  return getAuthTokenSnapshot();
};

export const clearAuthToken = (): TokenSnapshot => {
  ensureInitialized();
  token = null;
  generation += 1;
  writeStorage(null);
  notify();
  return getAuthTokenSnapshot();
};

export const applyRefreshedAuthToken = (
  requestSnapshot: TokenSnapshot,
  refreshedToken: string,
): boolean => {
  if (!isCurrentAuthTokenSnapshot(requestSnapshot)) return false;
  setAuthToken(refreshedToken);
  return true;
};

export const subscribeAuthToken = (listener: TokenListener): (() => void) => {
  listeners.add(listener);
  listener(getAuthTokenSnapshot());
  return () => listeners.delete(listener);
};
