import { handleResponses } from '@/lib/gateway/responses-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleResponses(request)
}
