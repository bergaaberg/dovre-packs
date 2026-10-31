/**
 * Topo's styles: the map (an SVG of bands, paths and places), the card and the list. Colours come
 * from Dovre's tokens, so light and dark follow the app; ok, warn and bad mean status only.
 */
export const CSS = String.raw`
.topo-wrap { display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start; margin-bottom: 20px; }
.topo-main { flex: 999 1 600px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.topo-card { flex: 1 1 320px; min-width: 0; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); box-shadow: var(--shadow); padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }

.topo-map { border: 1px solid var(--line); border-radius: var(--r); overflow: hidden; }
.topo-svg { display: block; width: 100%; height: auto; font-family: var(--mono); }
.topo-sea { fill: var(--surface); }
.topo-band { fill-rule: evenodd; }
.topo-band.b0 { fill: color-mix(in srgb, var(--ink) 10%, var(--surface)); }
.topo-band.b1 { fill: color-mix(in srgb, var(--ink) 6%, var(--surface)); }
.topo-band.b2 { fill: color-mix(in srgb, var(--ink) 3%, var(--surface)); }
.topo-minor { fill: none; stroke: var(--line-2); stroke-width: 0.8; }
.topo-idx { fill: none; stroke: color-mix(in srgb, var(--ink-3) 55%, transparent); stroke-width: 1.2; }
.topo-shore { fill: var(--surface-2); }
.topo-coast { fill: none; stroke: color-mix(in srgb, var(--ink-3) 55%, transparent); stroke-width: 1.2; }
.topo-hint { fill: none; stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 1 4; stroke-linecap: round; opacity: 0.7; }
.topo-hint.hot { stroke: var(--accent); stroke-width: 1.6; opacity: 1; }
.topo-tr { fill: none; stroke: var(--ink-3); stroke-width: 1.2; stroke-dasharray: 5 4; opacity: 0.55; }
.topo-tr.hot { stroke: var(--accent); stroke-width: 2.2; opacity: 1; }
.topo-tr.warn { stroke: var(--warn); stroke-width: 2.2; opacity: 1; stroke-dasharray: 3 3; }
.topo-ar { fill: var(--ink-3); opacity: 0.55; }
.topo-ar.hot { fill: var(--accent); opacity: 1; }
.topo-ar.warn { fill: var(--warn); opacity: 1; }
.topo-bl, .topo-shl { font-size: 9.5px; letter-spacing: 0.16em; font-weight: 600; fill: var(--ink-3); }
.topo-bl { text-anchor: middle; }
.topo-bl.start { text-anchor: start; }
.topo-shl.end { text-anchor: end; }
.topo-more { cursor: pointer; }
.topo-svc rect { fill: var(--surface); stroke: var(--line-2); stroke-dasharray: 3 2; }
.topo-svc text { font-size: 10.5px; fill: var(--ink-2); text-anchor: middle; }
.topo-svc.hot rect { stroke: var(--accent); }

.topo-place, .topo-chip { cursor: pointer; }
.topo-dot { fill: var(--ink); stroke: var(--surface); stroke-width: 2.5; }
.topo-place.on .topo-dot { fill: var(--accent); }
.topo-place.dep .topo-dot { fill: var(--surface); stroke: var(--ink-3); stroke-width: 2; }
.topo-pn { fill: var(--surface); stroke: var(--line); }
.topo-place:hover .topo-pn { stroke: var(--ink-3); }
.topo-place.on .topo-pn { fill: var(--accent); stroke: var(--accent); }
.topo-pt { font-size: 11px; font-weight: 500; fill: var(--ink); text-anchor: middle; }
.topo-place.on .topo-pt { fill: var(--accent-ink); }
.topo-place.dep .topo-pt { fill: var(--ink-3); text-decoration: line-through; }
.topo-place:focus-visible, .topo-chip:focus-visible { outline: none; }
.topo-place:focus-visible .topo-pn, .topo-chip:focus-visible .topo-cr { stroke: var(--accent); stroke-width: 2; }
.topo-badge { stroke: var(--surface); stroke-width: 2; }
.topo-badge.bad { fill: var(--bad); }
.topo-badge.warn { fill: var(--warn); }
.topo-bt { font-size: 10px; font-weight: 600; fill: var(--surface); text-anchor: middle; }
.topo-g { fill: var(--ink-2); }
.topo-g.miss { fill: var(--bad-soft); stroke: var(--bad); stroke-width: 1.5; }
.topo-g.repo { fill: none; stroke: var(--ink-3); stroke-dasharray: 2 1.5; }
.topo-cr { fill: var(--warn-soft); stroke: var(--warn); }
.topo-ct { font-size: 10.5px; fill: var(--ink); }
.topo-ck { font-size: 9.5px; fill: var(--ink-3); }
.topo-chip.on .topo-cr { fill: var(--accent); stroke: var(--accent); }
.topo-chip.on .topo-ct, .topo-chip.on .topo-ck { fill: var(--accent-ink); }
.topo-chip.on .topo-g { fill: var(--accent-ink); stroke: none; }

.topo-gi { width: 12px; height: 10px; flex: none; margin-right: 2px; }
.topo-legend { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: var(--fs-xs); color: var(--ink-3); padding: 0 4px; }
.topo-legend > span { display: inline-flex; align-items: center; gap: 4px; }
.topo-li { width: 22px; height: 6px; }
.topo-n { display: inline-block; min-width: 16px; height: 16px; border-radius: 8px; font-size: 10px; font-weight: 600; line-height: 16px; text-align: center; padding: 0 4px; color: var(--surface); }
.topo-n.bad { background: var(--bad); }
.topo-n.warn { background: var(--warn); }

.topo-phone { display: none; }
@media (max-width: 640px) {
  .topo-map { display: none; }
  .topo-phone { display: flex; flex-direction: column; gap: 8px; }
}
.topo-pband { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; border-radius: var(--r); background: color-mix(in srgb, var(--ink) 5%, var(--surface)); }
.topo-pband.off { background: var(--surface-2); }
.topo-ph, .topo-cs h3 { width: 100%; margin: 0; font-size: var(--fs-xs); letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-3); font-weight: 600; }
.topo-chips { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.topo-pchip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-s); padding: 3px 9px; border-radius: var(--r-s); border: 1px solid var(--line-2); background: var(--surface); color: var(--ink); text-decoration: none; }
a.topo-pchip:hover { background: var(--hover); }
.topo-pchip.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.topo-pchip.dep { text-decoration: line-through; color: var(--ink-3); }
.topo-pchip.warn { border-color: var(--warn); background: var(--warn-soft); }
.topo-pchip.svc { border-style: dashed; color: var(--ink-2); }

.topo-ch { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.topo-ch h2 { margin: 0; font-size: var(--fs-l); font-weight: 600; overflow-wrap: anywhere; }
.topo-sub { margin: -8px 0 0; font-size: var(--fs-xs); color: var(--ink-3); overflow-wrap: anywhere; }
.topo-about { margin: 0; font-size: var(--fs-s); color: var(--ink-2); }
.topo-cs { display: flex; flex-direction: column; gap: 8px; }
.topo-f { padding: 10px 12px; border-radius: var(--r-s); background: var(--surface-2); border: 1px solid var(--line); font-size: var(--fs-s); color: var(--ink-2); overflow-wrap: anywhere; }
.topo-fix { display: block; margin-top: 4px; }
.topo-sev { font-size: var(--fs-xs); font-weight: 600; padding: 1px 6px; border-radius: 5px; white-space: nowrap; }
.topo-sev.bad { background: var(--bad-soft); color: var(--bad); }
.topo-sev.warn { background: var(--warn-soft); color: var(--warn); }
.topo-sev.ok { background: var(--ok-soft); color: var(--ok); }
.topo-none { margin: 0; font-size: var(--fs-s); color: var(--ink-3); }
.topo-runs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-s); }
.topo-runs li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.topo-rn { flex: 1 1 12ch; min-width: 12ch; overflow-wrap: anywhere; }
.topo-envs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; margin-left: auto; max-width: 100%; }
.topo-comps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-s); }
.topo-comps li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.topo-owns { min-width: 0; overflow-wrap: anywhere; }
.topo-env { font-size: var(--fs-xs); padding: 0 6px; border-radius: 5px; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2); }
.topo-env.miss { background: var(--bad-soft); border-color: var(--bad); color: var(--bad); }

.topo-tw { overflow-x: auto; }
.topo-table { width: 100%; border-collapse: collapse; font-size: var(--fs-s); }
.topo-table th, .topo-table td { text-align: left; padding: 8px 12px; border-top: 1px solid var(--line); font-weight: 400; color: var(--ink-2); white-space: nowrap; }
.topo-table thead th { font-size: var(--fs-xs); color: var(--ink-3); background: var(--surface-2); }
.topo-table tbody th { font-weight: 500; color: var(--ink); }
.topo-table tr.on { background: var(--accent-soft); }
.topo-quiet { padding: 10px 12px; border-top: 1px solid var(--line); font-size: var(--fs-s); color: var(--ink-3); }
.topo-quiet summary { cursor: pointer; }
.topo-quiet .topo-chips { margin-top: 8px; }
`;
