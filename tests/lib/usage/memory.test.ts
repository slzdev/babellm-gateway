import { createMemoryStore } from '@/lib/usage/memory'
import { describeStoreContract } from './store-contract'

describeStoreContract('memory', createMemoryStore)
