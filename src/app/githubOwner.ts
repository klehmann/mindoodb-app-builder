/**
 * Filling in the GitHub owner the user did not type.
 *
 * Blank is a legitimate thing to leave: `POST /repos/{template}/generate` omits the field
 * and GitHub creates the repository under the token's own account. The problem is one
 * step earlier. The pre-flight name check asks `GET /repos/{owner}/{name}`, so a blank
 * owner requests `/repos//name`, GitHub answers 404, and the check reads that 404 as "the
 * name is free" — every name looks available until the create call rejects it.
 *
 * Resolving the login once, at the point the credentials are stored, keeps that check
 * meaningful and shows the user which account their token actually belongs to. Both ways
 * in need it: the device flow (which has a fresh token in hand) and a pasted token.
 */

/** A lookup that answers who a token belongs to. `getAuthenticatedUser` in practice. */
export type OwnerLookup = (token: string) => Promise<{ login: string }>;

export async function resolveGitHubOwner(options: {
  /** What the user typed. An organization here is a deliberate choice; never overwritten. */
  owner: string;
  token: string;
  lookup: OwnerLookup;
}): Promise<string> {
  const owner = options.owner.trim();
  if (owner || !options.token) {
    return owner;
  }

  try {
    return (await options.lookup(options.token)).login;
  } catch {
    // Reported, not thrown: a token that cannot answer this question is a problem the
    // first real call will describe far better than "could not save" would.
    return "";
  }
}
