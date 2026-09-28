import type { RcApi } from '@shared/types'
import { createMockApi } from './mockApi'

/** Inside Electron the preload script provides `window.rc`; in a plain browser we run the demo API. */
export const isDemo = !window.rc
export const api: RcApi = window.rc ?? createMockApi()
