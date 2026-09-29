import { z } from 'zod';
import { requestApiKey } from '@/lib/request-api-key';
import { authorized } from '@/lib/desk-auth';
import { startResearch, stopTrackingResearch } from '@/lib/research';
import { pollSweep, retrySchools, startSweep, stopSchoolTracking, sweepStatus } from '@/lib/research-sweep';

export async function GET(request: Request) {
  const denied = await authorized(request); if (denied) return denied;
  try { return Response.json(await sweepStatus(requestApiKey(request)), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return Response.json({ error: 'Search status is temporarily unavailable.' }, { status: 503 }); }
}

export async function POST(request: Request) {
  const denied = await authorized(request, true); if (denied) return denied;
  try {
    const apiKey = requestApiKey(request);
    const body = await request.text(); if (body.length > 2000) throw new Error('Request too large');
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('start'), scope: z.enum(['considering', 'all']), schoolIds: z.array(z.string().max(100)).min(1).max(150).optional() }).strict(),
      z.object({ action: z.literal('retry_school'), schoolId: z.string().max(100) }).strict(),
      z.object({ action: z.literal('stop_school_tracking'), schoolId: z.string().max(100) }).strict(),
      z.object({ action: z.literal('retry_incomplete') }).strict(),
      z.object({ action: z.literal('poll') }).strict(),
      z.object({ action: z.literal('stop_tracking'), requestId: z.string().regex(/^[a-f0-9]{24}$/).optional() }).strict(),
      z.object({ action: z.literal('analyze'), requestId: z.string().regex(/^[a-f0-9]{24}$/) }).strict(),
    ]).parse(JSON.parse(body));
    if (input.action === 'stop_school_tracking') await stopSchoolTracking(input.schoolId, apiKey);
    if (input.action === 'analyze') await startResearch('link', input.requestId, true, apiKey);
    if (input.action === 'stop_tracking') await stopTrackingResearch(input.requestId, apiKey);
    const result = input.action === 'start' ? await startSweep(input.scope, input.schoolIds, apiKey) : input.action === 'retry_school' ? await retrySchools(input.schoolId, apiKey) : input.action === 'retry_incomplete' ? await retrySchools(undefined, apiKey) : input.action === 'poll' ? await pollSweep(apiKey) : await sweepStatus(apiKey);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e instanceof z.ZodError ? 'Invalid search request.' : (e as Error).message || 'Search failed. Please retry.' }, { status: 400 });
  }
}
