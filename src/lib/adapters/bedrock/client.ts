import { BedrockRuntimeClient, type BedrockRuntimeClientConfig } from '@aws-sdk/client-bedrock-runtime'
import { BedrockClient, type BedrockClientConfig } from '@aws-sdk/client-bedrock'
import type { ProviderRuntime } from '../types'

export interface BedrockClientFactory {
  runtime?: (options: BedrockRuntimeClientConfig) => BedrockRuntimeClient
  control?: (options: BedrockClientConfig) => BedrockClient
}

function clientOptions(runtime: ProviderRuntime): BedrockClientConfig {
  const { region, accessKeyId, secretAccessKey, sessionToken, useInstanceRole } = runtime.credentials
  if (typeof region !== 'string' || !region.trim()) {
    throw new Error(`Provider "${runtime.name}" is missing a region credential.`)
  }
  if (useInstanceRole === true && (accessKeyId || secretAccessKey || sessionToken)) {
    throw new Error(`Provider "${runtime.name}" must choose default AWS credentials or static keys, not both.`)
  }
  const hasStatic = accessKeyId !== undefined || secretAccessKey !== undefined || sessionToken !== undefined
  if (hasStatic && (typeof accessKeyId !== 'string' || !accessKeyId || typeof secretAccessKey !== 'string' || !secretAccessKey)) {
    throw new Error(`Provider "${runtime.name}" requires both accessKeyId and secretAccessKey for static AWS credentials.`)
  }
  if (sessionToken !== undefined && typeof sessionToken !== 'string') {
    throw new Error(`Provider "${runtime.name}" sessionToken must be a string.`)
  }
  return {
    region: region.trim(),
    // SDK retries would hide attempts from gateway failover. Prefer IAM even
    // when the host happens to define AWS_BEARER_TOKEN_BEDROCK.
    maxAttempts: 1,
    authSchemePreference: ['sigv4'],
    ...(hasStatic ? { credentials: { accessKeyId: accessKeyId as string, secretAccessKey: secretAccessKey as string,
      ...(sessionToken ? { sessionToken: sessionToken as string } : {}) } } : {}),
  }
}

export function createBedrockRuntimeClient(
  runtime: ProviderRuntime,
  factory: NonNullable<BedrockClientFactory['runtime']> = (options) => new BedrockRuntimeClient(options),
): BedrockRuntimeClient {
  // Keep the SDK's default HTTP/2 handler. The adapter supplies cancellation
  // and per-send requestTimeout without silently replacing that handler.
  return factory({ ...clientOptions(runtime), ...(runtime.baseUrl ? { endpoint: runtime.baseUrl } : {}) })
}

export function createBedrockControlClient(
  runtime: ProviderRuntime,
  factory: NonNullable<BedrockClientFactory['control']> = (options) => new BedrockClient(options),
): BedrockClient {
  // Runtime endpoint overrides cannot address control-plane APIs.
  return factory(clientOptions(runtime))
}
