import type { RcApi } from '../shared/types'

declare global {
  interface Window {
    rc?: RcApi
  }
}
