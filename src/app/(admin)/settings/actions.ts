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
  //
  // `Object.hasOwn`, not `in`: DRIVERS is a plain object literal, so `in`
  // walks the prototype chain and treats "constructor", "toString", etc. as
  // present.
  if (!Object.hasOwn(DRIVERS, store)) {
    return { error: `Unknown log store: "${store}".` }
  }

  const retentionRaw = formData.get('retentionMonths')
  if (typeof retentionRaw !== 'string' || retentionRaw.trim() === '') {
    return { error: 'Retention is required — enter 0 to keep everything.' }
  }
  const retentionMonths = Number(retentionRaw)
  if (!Number.isFinite(retentionMonths)) {
    return { error: 'Retention must be a number.' }
  }

  try {
    await setLoggingSettings({
      store,
      retentionMonths,
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
