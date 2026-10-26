const PAIRING_TOKEN_PARAM = "token";

const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

/** Reads the pairing token from the URL fragment, or from the query for links that still use it. */
export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";

  if (hashToken.length > 0) {
    return hashToken;
  }

  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";

  return searchToken.length > 0 ? searchToken : null;
};

/** Removes the pairing token from the fragment and query, keeping every other parameter. */
export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hashParams = readHashParams(next);

  if (hashParams.has(PAIRING_TOKEN_PARAM)) {
    hashParams.delete(PAIRING_TOKEN_PARAM);
    next.hash = hashParams.toString();
  }

  next.searchParams.delete(PAIRING_TOKEN_PARAM);

  return next;
};

/** Puts the token in the fragment, so it never reaches server logs or a Referer header. */
export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();

  return next;
};
