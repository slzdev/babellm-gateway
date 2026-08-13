'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/admin/session'
import { DRIVERS, clearRequestLogStoreCache } from '@/lib/logs'
import { setLoggingSettings } from '@/lib/settings'

export interface ActionState {
  error?: string
  success?: string
}

export async function saveLoggingSettingsAction(
  _prev: ActionState | undefined,
  formData: FormData,
): Promise<ActionState> {
  await requireAdmin()
  const store = String(formData.get('store') ?? '')
  // setLoggingSettings deliberately skips this check — the Select only ever
  // offers known drivers, but a direct POST could send anything, and a typo
  // here should not silently start dropping every request log.
  if (!(store in DRIVERS)) {
    return { error: `Unknown log store: "${store}".` }
  }
  try {
    await setLoggingSettings({
      store,
      retentionDays: Number(formData.get('retentionDays')),
      payloadMaxBytes: Number(formData.get('payloadMaxBytes')),
    })
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Could not save the settings.' }
  }

  // This instance can stop serving the old store immediately. Other instances
  // pick the change up when their own cache expires.
  clearRequestLogStoreCache()
  revalidatePath('/settings')
  revalidatePath('/logs')
  return { success: 'Logging settings saved.' }
}
