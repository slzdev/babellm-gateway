import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { DecisionsApiFlavorSelect } from '@/components/admin/decisions-api-flavor-select'
import { ApiFlavorSelect } from '@/components/admin/api-flavor-select'

test('provider Decisions selector submits its independent OpenAI default', () => {
  const html = renderToStaticMarkup(<DecisionsApiFlavorSelect id="decisions" />)
  expect(html).toContain('name="decisionsApiFlavor"')
  expect(html).toContain('value="openai"')
  expect(html).toContain('OpenAI')
  expect(html).not.toContain('name="apiFlavor"')
})

test('Catalog Decisions selector submits empty inheritance and shows the provider default', () => {
  const html = renderToStaticMarkup(<DecisionsApiFlavorSelect id="decisions" defaultValue={null} providerDefault="openai" />)
  expect(html).toContain('name="decisionsApiFlavor"')
  expect(html).toContain('value=""')
  expect(html).toContain('(inherit — OpenAI)')
})

test('chat selector retains chat protocol choices separately from the Decisions selector', () => {
  const html = renderToStaticMarkup(<ApiFlavorSelect id="chat" defaultValue="responses" providerDefault="chat_completions" />)
  expect(html).toContain('name="apiFlavor"')
  expect(html).toContain('<option value="responses" selected="">Responses</option>')
  expect(html).toContain('Anthropic Messages')
  expect(html).not.toContain('Decisions')
})
