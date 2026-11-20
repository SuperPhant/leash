import type { ReactNode } from "react";
import { EXPLORER, MAINNET_EXPLORER } from "./config";
import { short } from "./util";

export function Card({ title, extra, children, className = "" }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || extra) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {extra && <div className="card-extra">{extra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: "ok" | "warn" | "bad" | "neutral" | "blue"; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Weight versus cap: the filled part is the position, the marker is the cap the agent cannot cross. */
export function WeightBar({ weightBps, capBps }: { weightBps: number; capBps: number }) {
  const w = Math.min(100, weightBps / 100);
  const c = Math.min(100, capBps / 100);
  const over = weightBps > capBps;
  return (
    <div className="wbar" title={`${(weightBps / 100).toFixed(1)}% of NAV, cap ${(capBps / 100).toFixed(0)}%`}>
      <div className={`wbar-fill ${over ? "over" : ""}`} style={{ width: `${w}%` }} />
      {capBps > 0 && <div className="wbar-cap" style={{ left: `${c}%` }} />}
    </div>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="mono" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? short(hash, 6)}
    </a>
  );
}

export function AddrLink({ address, label, mainnet = false }: { address: string; label?: string; mainnet?: boolean }) {
  return (
    <a className="mono" href={`${mainnet ? MAINNET_EXPLORER : EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {label ?? short(address)}
    </a>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function LineChart({ points, height = 140 }: { points: Array<[number, number]>; height?: number }) {
  if (points.length < 2) return <div className="muted small">NAV history appears after a few agent runs.</div>;
  const w = 640;
  const h = height;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo = Math.min(...ys);
  const hi = Math.max(...ys);
  const pad = (hi - lo) * 0.15 || hi * 0.01 || 1;
  const sx = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * (w - 8) + 4;
  const sy = (y: number) => h - 6 - ((y - (lo - pad)) / (hi + pad - (lo - pad))) * (h - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
  const up = ys[ys.length - 1] >= ys[0];
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="NAV history">
      <path d={`${d} L${sx(x1)},${h} L${sx(x0)},${h} Z`} className={up ? "area up" : "area down"} />
      <path d={d} className={up ? "line up" : "line down"} />
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
