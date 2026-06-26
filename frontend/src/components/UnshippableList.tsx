import { useMemo } from 'react'
import type { Product, RunResult } from '../types'

interface Props {
  result: RunResult
  products: Product[]
}

export function UnshippableList({ result, products }: Props) {
  const productName = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of products) m.set(p.id, p.name)
    return m
  }, [products])

  const rows = useMemo(
    () => result.units.filter((u) => u.status === 'unshippable'),
    [result.units],
  )

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-800">
        No unshippable units.
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <table className="min-w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-left px-3 py-2 font-medium">Product</th>
            <th className="text-left px-3 py-2 font-medium">Required start</th>
            <th className="text-left px-3 py-2 font-medium">Due date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((u) => (
            <tr key={u.id}>
              <td className="px-3 py-2">{productName.get(u.product_id) ?? '(unknown)'}</td>
              <td className="px-3 py-2 text-slate-600">{u.required_start}</td>
              <td className="px-3 py-2 text-rose-700">{u.due_date}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
