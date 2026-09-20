import { z } from 'zod';
import { authorized } from '@/lib/desk-auth';
import { pollAllResearch, researchStatus, startResearch } from '@/lib/research';

export async function GET(request: Request) {
  const denied = await authorized(request); if (denied) return denied;
  try { return Response.json(await researchStatus(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return Response.json({ error: 'Search status is temporarily unavailable.' }, { status: 503 }); }
}

export async function POST(request: Request) {
  const denied = await authorized(request, true); if (denied) return denied;
  try {
    const body = await request.text(); if (body.length > 2000) throw new Error('Request too large');
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('start'), scope: z.enum(['considering', 'all']) }).strict(),
      z.object({ action: z.literal('poll') }).strict(),
      z.object({ action: z.literal('analyze'), requestId: z.string().regex(/^[a-f0-9]{24}$/) }).strict(),
    ]).parse(JSON.parse(body));
    return Response.json(input.action === 'start' ? await startResearch(input.scope) : input.action === 'analyze' ? await startResearch('link', input.requestId, true) : await pollAllResearch(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e instanceof z.ZodError ? 'Invalid search request.' : (e as Error).message || 'Search failed. Please retry.' }, { status: 400 });
  }
}
