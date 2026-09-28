import { Link } from 'react-router-dom'
import { Database } from 'lucide-react'
import { useApp } from '@/lib/store'
import { EmptyState } from '@/components/Layout'

export function NoDataHint() {
  const { settings } = useApp()
  return (
    <EmptyState icon={<Database size={34} />} title="No statistics for this patch yet">
      <p>
        Rift Companion computes tier lists and builds from real high-elo matches that the built-in crawler collects
        through the official Riot API.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        {!settings?.hasApiKey && (
          <Link to="/settings" className="btn btn-ghost">
            Add API key
          </Link>
        )}
        <Link to="/data" className="btn btn-primary">
          Start crawler
        </Link>
      </div>
    </EmptyState>
  )
}
