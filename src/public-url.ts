export function publicUrl(path: string, base = import.meta.env?.BASE_URL ?? '/'): string {
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/.test(path)) {
    throw new Error('Invalid public resource path.');
  }
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(base)) throw new Error('Invalid application base path.');
  return `${base}${path.slice(1)}`;
}
