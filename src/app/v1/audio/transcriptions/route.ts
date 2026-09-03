import { handleTranscriptions } from '@/lib/gateway/transcriptions-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleTranscriptions(request)
}
