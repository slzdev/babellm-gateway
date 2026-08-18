import { errorResponse, GatewayError } from '@/lib/gateway/errors'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Retrieval, deletion, cancellation and input-item listing are deliberately
 * unimplemented — covering `/v1/responses/{id}`, `/v1/responses/{id}/cancel`
 * and `/v1/responses/{id}/input_items` alike via a catch-all segment, so all
 * four unsupported endpoints get this explanation rather than three of them
 * getting it and the rest falling through to Next's default 404.
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
