export class ProviderError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

// Only this fixed provider origin receives credentials. Never follow redirects.
export async function openAIResponse(path: string, body: unknown | undefined, apiKey: string) {
  if (path !== '' && !/^\/resp_[A-Za-z0-9_-]+$/.test(path)) throw new Error('Invalid research response path.');
  const url = 'https://api.openai.com/v1/responses' + path;
  let options: RequestInit;
  try {
    options = {
      method: body ? 'POST' : 'GET', redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
    };
    // Validate before sending, so a runtime incompatibility is not mistaken for
    // an uncertain paid request. Older workerd rejects redirect: 'error'.
    new Request(url, options);
  } catch {
    throw new Error('The website could not prepare the OpenAI request. Nothing was sent. Reload the updated website and try again.');
  }
  let response: Response;
  try { response = await fetch(url, options); }
  catch (error) {
    const timedOut = options.signal?.aborted || (error as Error)?.name === 'TimeoutError';
    throw new Error(body
      ? `The connection to OpenAI ${timedOut ? 'timed out' : 'failed'} before a search ID was received. Check API usage before retrying; the request may have reached OpenAI.`
      : 'Could not connect to OpenAI to check progress. Your search is saved; retry status shortly.');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ProviderError('OpenAI returned an unexpected redirect. It was blocked to protect your API key.', response.status);
  }
  if (!response.ok) {
    // Classify provider errors without exposing raw messages, headers or keys.
    const detail = await response.json().catch(() => null) as { error?: { code?: string; type?: string } } | null;
    const code = detail?.error?.code || detail?.error?.type;
    if (response.status === 401) throw new ProviderError('The API key was rejected. Update it using API key.', 401);
    if (code === 'insufficient_quota') throw new ProviderError('OpenAI API credits or spending quota are exhausted. Check billing and project limits on platform.openai.com before retrying.', response.status);
    if (response.status === 429) throw new ProviderError('OpenAI rate or usage limit reached. Check your project limits; wait before retrying.', 429);
    if (code === 'model_not_found') throw new ProviderError('This API project cannot access the configured research model. Check model access in your OpenAI project.', response.status);
    if (response.status === 403) throw new ProviderError('This API key or project does not have permission to run research. Check its Responses API permissions.', 403);
    throw new ProviderError(`OpenAI rejected the research request (HTTP ${response.status}). Check the API configuration before retrying.`, response.status);
  }
  try { return await response.json() as any; }
  catch { throw new Error('OpenAI returned an unreadable response. Check API usage before retrying; no findings were imported.'); }
}
