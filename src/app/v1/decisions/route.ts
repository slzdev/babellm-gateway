import { handleDecisions } from '@/lib/gateway/decisions-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleDecisions(request)
}
