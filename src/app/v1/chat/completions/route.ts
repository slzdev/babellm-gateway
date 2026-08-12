import { handleChatCompletions } from '@/lib/gateway/chat-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleChatCompletions(request)
}
