import type { Risk } from '@/lib/api';
import { RISK_LABEL } from '@/lib/format';

export function RiskBadge({ risk }: { risk: Risk }) {
  return <span className={`badge risk-${risk}`}>{RISK_LABEL[risk]}</span>;
}

export function Status({ value, title }: { value: string; title?: string }) {
  return (
    <span className={`st-${value}`} title={title}>
      ● {value}
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return <p className="muted">Loading {what}…</p>;
}
