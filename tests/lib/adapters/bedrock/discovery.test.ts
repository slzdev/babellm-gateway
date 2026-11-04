import { expect, test } from 'vitest'
import type { BedrockClient } from '@aws-sdk/client-bedrock'
import { listModels } from '@/lib/adapters/bedrock/discovery'

const foundation = { modelId: 'vendor.text-v1', modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/vendor.text-v1', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], responseStreamingSupported: true, inferenceTypesSupported: ['ON_DEMAND'] }
const profileOnly = { ...foundation, modelId: 'vendor.profile-only', modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/vendor.profile-only', inferenceTypesSupported: ['INFERENCE_PROFILE'] }
const ctx = { signal: new AbortController().signal }

test('discovers direct on-demand text models and active paginated profiles, inherits only known metadata and deduplicates', async () => {
  const calls: { name: string; input: unknown; signal: unknown }[] = []
  const client = { send: async (command: { constructor: { name: string }; input: { nextToken?: string } }, options: { abortSignal: AbortSignal }) => {
    calls.push({ name: command.constructor.name, input: command.input, signal: options.abortSignal })
    if (command.constructor.name === 'ListFoundationModelsCommand') return { modelSummaries: [foundation, foundation, profileOnly, { ...foundation, modelId: 'batch-only', inferenceTypesSupported: ['PROVISIONED'] }, { ...foundation, modelId: 'image', outputModalities: ['IMAGE'] }] }
    if (!command.input.nextToken) return { nextToken: 'page2', inferenceProfileSummaries: [{ inferenceProfileId: 'us.vendor', status: 'ACTIVE', type: 'SYSTEM_DEFINED', models: [{ modelArn: 'arn:aws:bedrock:eu-west-1::foundation-model/vendor.profile-only' }] }, { inferenceProfileId: 'inactive', status: 'INACTIVE' }] }
    return { inferenceProfileSummaries: [{ inferenceProfileId: 'app', inferenceProfileArn: 'arn:aws:bedrock:us-east-1:123:application-inference-profile/app', type: 'APPLICATION', status: 'ACTIVE', models: [{ modelArn: 'unknown' }] }, { inferenceProfileId: 'us.vendor', status: 'ACTIVE' }] }
  } } as unknown as BedrockClient
  const models = await listModels(client, ctx)
  expect(models.map((m) => m.id)).toEqual(['vendor.text-v1', 'us.vendor', 'arn:aws:bedrock:us-east-1:123:application-inference-profile/app'])
  expect(models[1].fields).toEqual({ kind: 'chat', modalities: { input: ['text', 'image'], output: ['text'] }, supportsStreaming: true })
  expect(models[2].fields).toEqual({})
  expect(calls[0].input).toEqual({ byOutputModality: 'TEXT' })
  expect(calls[2].input).toEqual({ nextToken: 'page2' })
  expect(calls.every((call) => call.signal === ctx.signal)).toBe(true)
})
test.each([1, 3])('discovery rejects the entire listing when operation %i fails', async (failAt) => {
  let count = 0
  const client = { send: async () => { count++; if (count === failAt) throw Object.assign(new Error('IAM denied'), { name: 'AccessDeniedException' }); return count === 1 ? { modelSummaries: [foundation] } : { nextToken: 'next', inferenceProfileSummaries: [{ inferenceProfileId: 'valid', status: 'ACTIVE' }] } } } as unknown as BedrockClient
  await expect(listModels(client, ctx)).rejects.toThrow('IAM denied')
})
