import { hostLibrary } from '../tsdown.client.ts'

export default hostLibrary(import.meta.dirname, ['lib/types/index.js'])
