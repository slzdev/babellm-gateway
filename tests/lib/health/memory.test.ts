import { createMemoryHealthStore } from '@/lib/health/memory'
import { describeHealthStoreContract } from './store-contract'

describeHealthStoreContract('memory', () => createMemoryHealthStore())
