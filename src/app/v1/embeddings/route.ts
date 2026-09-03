import { handleEmbeddings } from '@/lib/gateway/embeddings-handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  return handleEmbeddings(request)
}
