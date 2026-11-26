/** Keep exact user IDs opaque, including literal "all" and reserved URL characters. */
export function withUser(path: string, user: string | undefined) {
  const url = new URL(path, 'https://edgewatch.invalid');
  if (user !== undefined) url.searchParams.set('user', user);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function userActivityLinks(user: string) {
  return [['Requests', '/requests'], ['Jobs', '/jobs'], ['Exceptions', '/exceptions'], ['Logs', '/logs']]
    .map(([label, path]) => ({ label, to: withUser(path, user) }));
}
