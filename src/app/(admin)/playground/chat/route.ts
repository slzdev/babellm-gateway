import { handlePlaygroundChat } from '@/lib/admin/playground-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function POST(request: Request): Promise<Response> {
  return handlePlaygroundChat(request)
}
