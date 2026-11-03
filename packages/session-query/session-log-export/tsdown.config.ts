import { hostLibrary } from '../../client/tsdown.client.ts'

export default hostLibrary(import.meta.dirname, ['lib/types/index.js'])
