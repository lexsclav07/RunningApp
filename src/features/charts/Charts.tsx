import { useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Defs, Line, LinearGradient, Path, Stop, Text as SvgText } from 'react-native-svg';

import { formatClock, formatDistance, makeProjection, type Climb, type RoutePoint } from '@/core';
import { useTheme } from '@/ui';
import { formatDay } from '@/ui/dates';

function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [w, setW] = useState(0);
  return [w, (e) => setW(Math.round(e.nativeEvent.layout.width))];
}

const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');

/** Thin a series to about `n` points for drawing. */
function thin<T>(xs: T[], n = 240): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * step)]);
  out.push(xs[xs.length - 1]);
  return out;
}

/** The route's outline, north up, with start (filled) and finish (ring) markers. */
export function RouteShape({ points, height = 180 }: { points: RoutePoint[]; height?: number }) {
  const { colors } = useTheme();
  const [width, onLayout] = useWidth();
  let body = null;
  if (width > 0 && points.length > 1) {
    const proj = makeProjection(points[0]);
    const xy = thin(points, 400).map((p) => proj.toXY(p));
    const xs = xy.map((p) => p.x);
    const ys = xy.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const pad = 16;
    const k = Math.min((width - 2 * pad) / Math.max(maxX - minX, 1), (height - 2 * pad) / Math.max(maxY - minY, 1));
    const ox = (width - (maxX - minX) * k) / 2;
    const oy = (height - (maxY - minY) * k) / 2;
    const screen = xy.map((p) => ({ x: ox + (p.x - minX) * k, y: height - (oy + (p.y - minY) * k) }));
    const a = screen[0];
    const b = screen[screen.length - 1];
    body = (
      <Svg width={width} height={height}>
        <Path d={path(screen)} stroke={colors.accent} strokeWidth={3.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        <Circle cx={b.x} cy={b.y} r={6} stroke={colors.label} strokeWidth={2.5} fill={colors.surface} />
        <Circle cx={a.x} cy={a.y} r={4.5} fill={colors.label} />
      </Svg>
    );
  }
  return (
    <View onLayout={onLayout} style={{ height }} accessible accessibilityRole="image" accessibilityLabel="Route outline. Filled dot marks the start, ring marks the finish.">
      {body}
    </View>
  );
}

/** Elevation against distance; climbs are shaded. Shows nothing useful when elevation is unreliable. */
export function ElevationProfile({ points, climbs, height = 120 }: { points: RoutePoint[]; climbs: Climb[]; height?: number }) {
  const { colors } = useTheme();
  const [width, onLayout] = useWidth();
  const valid = points.filter((p): p is RoutePoint & { ele: number } => p.ele !== null);
  const label =
    valid.length > 1
      ? `Elevation profile from ${Math.round(Math.min(...valid.map((p) => p.ele)))} to ${Math.round(Math.max(...valid.map((p) => p.ele)))} metres, ${climbs.length} climb${climbs.length === 1 ? '' : 's'}`
      : 'No reliable elevation data';
  let body = null;
  if (width > 0 && valid.length > 1) {
    const pts = thin(valid);
    const length = points[points.length - 1].d || 1;
    const lo = Math.min(...pts.map((p) => p.ele));
    const hi = Math.max(...pts.map((p) => p.ele), lo + 10);
    const top = 14;
    const bottom = height - 18;
    const X = (d: number) => (d / length) * width;
    const Y = (e: number) => bottom - ((e - lo) / (hi - lo)) * (bottom - top);
    const line = pts.map((p) => ({ x: X(p.d), y: Y(p.ele) }));
    const area = `${path(line)}L${width},${bottom}L0,${bottom}Z`;
    body = (
      <Svg width={width} height={height}>
        <Defs>
          <LinearGradient id="ele" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.accent} stopOpacity={0.35} />
            <Stop offset="1" stopColor={colors.accent} stopOpacity={0.04} />
          </LinearGradient>
        </Defs>
        {climbs.map((c) => (
          <Path key={c.startD} d={`M${X(c.startD)},${top - 6}L${X(c.endD)},${top - 6}L${X(c.endD)},${bottom}L${X(c.startD)},${bottom}Z`} fill={colors.fill} />
        ))}
        <Path d={area} fill="url(#ele)" />
        <Path d={path(line)} stroke={colors.accent} strokeWidth={2} fill="none" />
        <Line x1={0} x2={width} y1={bottom} y2={bottom} stroke={colors.separator} strokeWidth={1} />
        <SvgText x={2} y={height - 4} fontSize={11} fill={colors.secondaryLabel}>
          0
        </SvgText>
        <SvgText x={width - 2} y={height - 4} fontSize={11} fill={colors.secondaryLabel} textAnchor="end">
          {formatDistance(length)}
        </SvgText>
        <SvgText x={2} y={11} fontSize={11} fill={colors.secondaryLabel}>
          {`${Math.round(hi)} m`}
        </SvgText>
      </Svg>
    );
  }
  return (
    <View onLayout={onLayout} style={{ height }} accessible accessibilityRole="image" accessibilityLabel={label}>
      {body}
    </View>
  );
}

/** Finish time per run, oldest to newest, faster higher; the best run is highlighted and the baseline dashed. */
export function FinishTimeChart({
  series,
  baselineSec,
  bestRunId,
  height = 170,
}: {
  series: { runId: string; startedAt: number; finishSec: number }[];
  baselineSec: number | null;
  bestRunId: string | null;
  height?: number;
}) {
  const { colors } = useTheme();
  const [width, onLayout] = useWidth();
  let body = null;
  if (width > 0 && series.length > 0) {
    const times = series.map((s) => s.finishSec).concat(baselineSec ?? []);
    const lo = Math.min(...times);
    const hi = Math.max(...times);
    const span = Math.max(hi - lo, 20);
    const yLo = lo - span * 0.15;
    const yHi = hi + span * 0.15;
    const left = 46;
    const right = 10;
    const top = 10;
    const bottom = height - 22;
    const X = (i: number) => (series.length === 1 ? (left + width - right) / 2 : left + (i / (series.length - 1)) * (width - left - right));
    // faster (smaller) times plot higher, so improvement reads as an upward line
    const Y = (t: number) => top + ((t - yLo) / (yHi - yLo)) * (bottom - top);
    const pts = series.map((s, i) => ({ x: X(i), y: Y(s.finishSec) }));
    body = (
      <Svg width={width} height={height}>
        {[yLo + (yHi - yLo) * 0.15, (yLo + yHi) / 2, yHi - (yHi - yLo) * 0.15].map((t) => (
          <SvgText key={t} x={left - 6} y={Y(t) + 4} fontSize={11} fill={colors.secondaryLabel} textAnchor="end">
            {formatClock(t)}
          </SvgText>
        ))}
        {baselineSec !== null ? (
          <Line x1={left} x2={width - right} y1={Y(baselineSec)} y2={Y(baselineSec)} stroke={colors.secondaryLabel} strokeDasharray="4 4" strokeWidth={1} />
        ) : null}
        {pts.length > 1 ? <Path d={path(pts)} stroke={colors.accent} strokeWidth={2.5} fill="none" strokeLinejoin="round" /> : null}
        {pts.map((p, i) => (
          <Circle
            key={series[i].runId}
            cx={p.x}
            cy={p.y}
            r={series[i].runId === bestRunId ? 6 : 4}
            fill={series[i].runId === bestRunId ? colors.accent : colors.surface}
            stroke={colors.accent}
            strokeWidth={2}
          />
        ))}
        <SvgText x={left} y={height - 4} fontSize={11} fill={colors.secondaryLabel}>
          {formatDay(series[0].startedAt)}
        </SvgText>
        {series.length > 1 ? (
          <SvgText x={width - right} y={height - 4} fontSize={11} fill={colors.secondaryLabel} textAnchor="end">
            {formatDay(series[series.length - 1].startedAt)}
          </SvgText>
        ) : null}
      </Svg>
    );
  }
  const desc = series.map((s) => `${formatDay(s.startedAt)} ${formatClock(s.finishSec)}`).join(', ');
  return (
    <View onLayout={onLayout} style={{ height }} accessible accessibilityRole="image" accessibilityLabel={`Finish times, faster runs plot higher: ${desc}`}>
      {body}
    </View>
  );
}

/** Seconds ahead (above zero) or behind (below) along the route. */
export function AdvantageChart({ series, length, height = 140 }: { series: { d: number; advantage: number }[]; length: number; height?: number }) {
  const { colors } = useTheme();
  const [width, onLayout] = useWidth();
  let body = null;
  if (width > 0 && series.length > 1) {
    const pts = thin(series);
    const m = Math.max(5, ...pts.map((p) => Math.abs(p.advantage))) * 1.15;
    const mid = height / 2;
    const X = (d: number) => (d / (length || 1)) * width;
    const Y = (a: number) => mid - (a / m) * (mid - 8);
    const area = (sign: 1 | -1) =>
      `M${X(pts[0].d)},${mid}` +
      pts.map((p) => `L${X(p.d).toFixed(1)},${Y(sign > 0 ? Math.max(0, p.advantage) : Math.min(0, p.advantage)).toFixed(1)}`).join('') +
      `L${X(pts[pts.length - 1].d)},${mid}Z`;
    body = (
      <Svg width={width} height={height}>
        <Path d={area(1)} fill={colors.ahead} fillOpacity={0.3} />
        <Path d={area(-1)} fill={colors.behind} fillOpacity={0.3} />
        <Path d={path(pts.map((p) => ({ x: X(p.d), y: Y(p.advantage) })))} stroke={colors.label} strokeWidth={1.5} fill="none" />
        <Line x1={0} x2={width} y1={mid} y2={mid} stroke={colors.label} strokeWidth={1} />
        <SvgText x={4} y={14} fontSize={11} fill={colors.secondaryLabel}>
          {`AHEAD +${Math.round(m)} s`}
        </SvgText>
        <SvgText x={4} y={height - 4} fontSize={11} fill={colors.secondaryLabel}>
          {`BEHIND −${Math.round(m)} s`}
        </SvgText>
      </Svg>
    );
  }
  const last = series[series.length - 1];
  return (
    <View
      onLayout={onLayout}
      style={[styles.chart, { height }]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={last ? `Time ahead or behind along the route, ending ${Math.round(last.advantage)} seconds` : 'No comparison data'}
    >
      {body}
    </View>
  );
}

const styles = StyleSheet.create({ chart: { overflow: 'hidden' } });
