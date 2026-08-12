'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function CredentialField({
  id, name, label, type = 'text', required = false, placeholder,
}: {
  id: string
  name: string
  label: string
  type?: string
  required?: boolean
  placeholder?: string
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
      />
    </div>
  )
}
