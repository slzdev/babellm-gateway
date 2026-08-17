import { errorResponse, GatewayError } from '@/lib/gateway/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Retrieval, deletion and cancellation are deliberately unimplemented.
 *
 * None of them carries a `model`, and this gateway passes provider response ids
 * through unrewritten, so there is nothing to route on: the id names a
 * conversation on one provider, and the request does not say which. Answering
 * with an explanation beats a bare 404 from the router.
 */
function unsupported(): Response {
  return errorResponse(new GatewayError({
    status: 404,
    type: 'invalid_request_error',
    code: 'unsupported_endpoint',
    message: 'This gateway serves POST /v1/responses only. Retrieving, cancelling or deleting a stored response is not supported, because response ids are passed through from the provider and carry no routing information.',
  }))
}

export const GET = unsupported
export const DELETE = unsupported
export const POST = unsupported
