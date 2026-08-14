import { buildStatus } from '@/lib/status'

export const runtime = 'nodejs'
// Without this the handler is prerendered at build time and every probe reads
// an uptime frozen at the moment the image was built.
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  return Response.json(buildStatus(), { headers: { 'Cache-Control': 'no-store' } })
}

// Load balancers commonly probe with HEAD, and only OPTIONS is filled in
// automatically.
export async function HEAD(): Promise<Response> {
  return new Response(null, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}
