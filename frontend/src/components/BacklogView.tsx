import { useMemo, useState } from 'react'
import type { RunResult } from '../types'

interface Props {
  result: RunResult
}

function quarterOf(date: string): { key: number; label: string } | null {
  const year = parseInt(date.slice(0, 4), 10)
  const month = parseInt(date.slice(5, 7), 10)
  if (!year || !month) return null
  const q = Math.floor((month - 1) / 3) + 1
  return { key: year * 4 + q, label: `${year} Q${q}` }
}

interface Row {
  key: number
  label: string
  demand: number
  onTime: number
  rolledOut: number
  rolledIn: number
  unshippable: number
}

interface ShipRow {
  key: number
  label: string
  shipped: number
  onTime: number
  late: number
}

/**
 * Per-quarter backlog table:
 *  - demand:      units originally demanded in the quarter
 *  - on time:     shipped in the demanded quarter
 *  - rolled out:  units that missed the quarter and rolled forward (each quarter counted)
 *  - rolled in:   units that shipped late, landing in this quarter
 *  - unshippable: demanded here but never shipped within the horizon
 */
export function BacklogView({ result }: Props) {
  const [showActualShipments, setShowActualShipments] = useState(false)
  const rows = useMemo<Row[]>(() => {
    const map = new Map<number, Row>()
    const get = (q: { key: number; label: string }) => {
      let r = map.get(q.key)
      if (!r) {
        r = { key: q.key, label: q.label, demand: 0, onTime: 0, rolledOut: 0, rolledIn: 0, unshippable: 0 }
        map.set(q.key, r)
      }
      return r
    }

    for (const u of result.units) {
      const origQ = quarterOf(u.orig_due_date ?? u.due_date)
      const shipQ = quarterOf(u.due_date)
      if (origQ) {
        const r = get(origQ)
        r.demand += 1
        if (u.status === 'unshippable') r.unshippable += 1
        else if (!u.is_late) r.onTime += 1
      }
      if (u.is_late && u.status !== 'unshippable' && shipQ) {
        get(shipQ).rolledIn += 1
      }
    }

    // Rolled-out comes from the per-quarter miss counts (counts each quarter missed).
    for (const m of result.quarter_misses) {
      const key = m.year * 4 + m.quarter
      const r = map.get(key) ?? {
        key,
        label: `${m.year} Q${m.quarter}`,
        demand: 0,
        onTime: 0,
        rolledOut: 0,
        rolledIn: 0,
        unshippable: 0,
      }
      r.rolledOut += m.missed_count
      map.set(key, r)
    }

    return [...map.values()].sort((a, b) => a.key - b.key)
  }, [result])

  const shipmentRows = useMemo<ShipRow[]>(() => {
    const map = new Map<number, ShipRow>()
    const get = (q: { key: number; label: string }) => {
      let r = map.get(q.key)
      if (!r) {
        r = { key: q.key, label: q.label, shipped: 0, onTime: 0, late: 0 }
        map.set(q.key, r)
      }
      return r
    }
    for (const u of result.units) {
      if (u.status === 'unshippable') continue
      const shipQ = quarterOf(u.due_date)
      if (!shipQ) continue
      const r = get(shipQ)
      r.shipped += 1
      if (u.is_late) r.late += 1
      else r.onTime += 1
    }
    return [...map.values()].sort((a, b) => a.key - b.key)
  }, [result])

  if (rows.length === 0) {
    return <div className="text-sm text-slate-500">No demand to report.</div>
  }

  const totalMissed = result.quarter_misses.reduce((s, m) => s + m.missed_count, 0)

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-2 text-xs text-slate-500 border-b border-slate-100">
        Units that fit their demanded quarter are scheduled first; the rest become backlog and
        are forward-scheduled to ship as early as capacity frees up afterward, shipping{' '}
        <strong>late</strong>. <strong>Rolled out</strong> counts every quarter a unit misses
        {totalMissed > 0 && ` (${totalMissed} total)`}.
      </div>
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Quarter</th>
            <th className="text-right px-3 py-2 font-medium">Demand</th>
            <th className="text-right px-3 py-2 font-medium">On time</th>
            <th className="text-right px-3 py-2 font-medium">Rolled out →</th>
            <th className="text-right px-3 py-2 font-medium">→ Rolled in</th>
            <th className="text-right px-3 py-2 font-medium">Unshippable</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="px-3 py-1.5 font-medium">{r.label}</td>
              <td className="px-3 py-1.5 text-right">{r.demand || ''}</td>
              <td className="px-3 py-1.5 text-right text-emerald-700">{r.onTime || ''}</td>
              <td className="px-3 py-1.5 text-right text-amber-600">{r.rolledOut || ''}</td>
              <td className="px-3 py-1.5 text-right text-indigo-600">{r.rolledIn || ''}</td>
              <td className="px-3 py-1.5 text-right text-rose-600">{r.unshippable || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-slate-100">
        <button
          type="button"
          className="w-full px-4 py-2 text-left text-sm font-medium text-slate-700 hover:bg-slate-50 flex items-center justify-between"
          onClick={() => setShowActualShipments((v) => !v)}
        >
          <span>Actual shipments by quarter</span>
          <span className="text-xs text-slate-500">
            {showActualShipments ? 'Hide' : `Show ${shipmentRows.length} quarters`}
          </span>
        </button>
        {showActualShipments && (
          <div>
            <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-100">
              This table uses each unit's actual scheduled ship date. It shows plant output even
              when those shipments are late backlog from earlier demand periods.
            </div>
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Ship quarter</th>
                  <th className="text-right px-3 py-2 font-medium">Total shipped</th>
                  <th className="text-right px-3 py-2 font-medium">On-time</th>
                  <th className="text-right px-3 py-2 font-medium">Late backlog</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shipmentRows.map((r) => (
                  <tr key={r.key}>
                    <td className="px-3 py-1.5 font-medium">{r.label}</td>
                    <td className="px-3 py-1.5 text-right">{r.shipped}</td>
                    <td className="px-3 py-1.5 text-right text-emerald-700">{r.onTime || ''}</td>
                    <td className="px-3 py-1.5 text-right text-indigo-600">{r.late || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
