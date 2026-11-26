'use client';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface Point {
  at: number;
  healthFactor: number | null;
  ok: boolean;
}

const THRESHOLD_COLORS = ['#e3b341', '#f0883e', '#f85149', '#f85149', '#f85149'];

export function HfChart({ points, thresholds }: { points: Point[]; thresholds: number[] }) {
  const values = points.map((p) => p.healthFactor).filter((v): v is number => v !== null);
  if (values.length === 0) {
    return <p className="muted">No health-factor history yet (no debt, or no successful reading in this period).</p>;
  }
  const sorted = [...thresholds].sort((a, b) => b - a);
  const top = Math.min(Math.max(...values, sorted[0] ?? 1.5) * 1.08, 10);
  const bottom = Math.max(0, Math.min(...values, 1) - 0.05);
  const spanMs = points.length > 1 ? points[points.length - 1]!.at - points[0]!.at : 0;
  const tick = (t: number) =>
    new Date(t).toLocaleString(undefined, spanMs > 36 * 3_600_000 ? { month: 'short', day: 'numeric' } : { hour: '2-digit', minute: '2-digit' });

  return (
    <div style={{ width: '100%', height: 320 }} role="img" aria-label="Health factor history chart">
      <ResponsiveContainer>
        <LineChart data={points} margin={{ top: 10, right: 60, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#2a3340" strokeDasharray="3 3" />
          <XAxis dataKey="at" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={tick} stroke="#8b98a8" fontSize={12} />
          <YAxis domain={[bottom, top]} stroke="#8b98a8" fontSize={12} tickFormatter={(v: number) => v.toFixed(2)} width={48} />
          <Tooltip
            contentStyle={{ background: '#161b22', border: '1px solid #2a3340', borderRadius: 8 }}
            labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
            formatter={(v) => [v === null || v === undefined ? 'read failed' : Number(v).toFixed(3), 'Health factor']}
          />
          <ReferenceLine y={1} stroke="#f85149" strokeWidth={2} label={{ value: 'HF 1 · liquidation', fill: '#f85149', fontSize: 11, position: 'right' }} />
          {sorted.map((t, i) => (
            <ReferenceLine
              key={t}
              y={t}
              stroke={THRESHOLD_COLORS[i] ?? '#e3b341'}
              strokeDasharray="6 4"
              label={{ value: `alert ${t}`, fill: THRESHOLD_COLORS[i] ?? '#e3b341', fontSize: 11, position: 'right' }}
            />
          ))}
          {/* Gaps (no line) where a read failed: we never draw data we did not get. */}
          <Line type="monotone" dataKey="healthFactor" stroke="#7aa2ff" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
