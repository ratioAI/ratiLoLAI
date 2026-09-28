import { Link } from 'react-router-dom'
import { Database } from 'lucide-react'
import { useApp } from '@/lib/store'
import { EmptyState } from '@/components/Layout'

export function NoDataHint() {
  const { settings } = useApp()
  return (
    <EmptyState icon={<Database size={34} />} title="Noch keine Statistiken für diesen Patch">
      <p>
        Rift Companion berechnet Tierliste und Builds aus echten High-Elo-Matches, die der integrierte Crawler über die
        offizielle Riot API sammelt.
      </p>
      <div className="mt-5 flex justify-center gap-2">
        {!settings?.hasApiKey && (
          <Link to="/settings" className="btn btn-ghost">
            API Key hinterlegen
          </Link>
        )}
        <Link to="/data" className="btn btn-primary">
          Crawler starten
        </Link>
      </div>
    </EmptyState>
  )
}
