export function requestApiKey(request: Request): string | undefined {
  const value = request.headers.get('X-OpenAI-API-Key');
  if (value === null) return undefined;
  const key = value.trim();
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key) || key.length > 1024) throw new Error('The saved API key has an invalid format. Update it using API key.');
  return key;
}
