'use client'

import { useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

/**
 * The one moment a secret is on screen. Shared by creation and rotation —
 * both mint a key the server keeps only as a hash, so both get exactly one
 * chance to hand it over.
 */
export function KeyReveal({
  title, description, plaintextKey, onDone,
}: {
  title: string
  description: string
  plaintextKey: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(plaintextKey)
      setCopied(true)
      toast.success('Key copied to the clipboard.')
    } catch {
      // Clipboard access can be denied; the key is on screen either way.
      toast.error('Could not copy — select the key and copy it by hand.')
    }
  }

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className="flex items-start gap-2 rounded-md border border-dashed p-3">
        <code className="flex-1 break-all font-mono text-sm">{plaintextKey}</code>
        <Button type="button" variant="outline" size="icon-sm" onClick={copy} aria-label="Copy key">
          {copied ? <CheckIcon /> : <CopyIcon />}
        </Button>
      </div>

      <DialogFooter>
        <Button type="button" onClick={onDone}>Done</Button>
      </DialogFooter>
    </div>
  )
}

/**
 * The reveal with a dialog of its own, for rotation — where there is no
 * preceding form to share a dialog with.
 *
 * Nothing but Done closes it: the secret is already saved server-side, so a
 * stray Escape or backdrop click would lose it for good. Same reasoning as
 * the create dialog's close-gate, which reaches the identical state by
 * swapping its form out for this.
 */
export function KeyRevealDialog({
  plaintextKey, onDone,
}: {
  plaintextKey: string | null
  onDone: () => void
}) {
  return (
    <Dialog open={plaintextKey !== null} onOpenChange={() => {}}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        {plaintextKey !== null ? (
          <KeyReveal
            title="API key rotated"
            description="Copy the new key now — it is never shown again. The previous one has already stopped working."
            plaintextKey={plaintextKey}
            onDone={onDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
