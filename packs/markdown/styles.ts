/** Markdown (`markdown`) styles: only the pack's own classes (core scopes them). */
export const styles = `
.md-split { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1000px) { .md-split { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; } }
.md-editor textarea { font-family: var(--mono); font-size: var(--fs-s); line-height: 1.5; width: 100%; resize: vertical; }
.md-tools { display: flex; gap: 12px; align-items: center; margin-bottom: 8px; }
.md-open { font-size: var(--fs-s); color: var(--ink-2); }
.md-open input { font-size: var(--fs-s); margin-left: 6px; }
.md-copy textarea { display: none; }
.md-doc { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1100px) { .md-doc { grid-template-columns: minmax(0, 1fr) 260px; align-items: start; } .md-side { position: sticky; top: 16px; } }
.md-files { list-style: none; margin: 0; padding: 0; columns: 2 280px; }
.md-files li { padding: 3px 0; break-inside: avoid; overflow-wrap: anywhere; }
.md-outline { list-style: none; margin: 0; padding: 0; font-size: var(--fs-s); }
.md-outline li { padding: 2px 0; } .md-outline .md-l2 { padding-left: 10px; } .md-outline .md-l3 { padding-left: 20px; }
.md-broken-list { margin: 0; padding-left: 1.1rem; font-size: var(--fs-s); }
.md-body { line-height: 1.65; overflow-wrap: break-word; }
.md-body > :first-child { margin-top: 0; }
.md-body h1, .md-body h2, .md-body h3, .md-body h4 { line-height: 1.25; margin: 1.4em 0 .5em; scroll-margin-top: 16px; }
.md-body h1 { font-size: 1.7em; } .md-body h2 { font-size: 1.35em; } .md-body h3 { font-size: 1.15em; } .md-body h4 { font-size: 1em; }
.md-body h1, .md-body h2 { border-bottom: 1px solid var(--line); padding-bottom: .3em; }
.md-body p, .md-body ul, .md-body ol, .md-body blockquote, .md-body pre { margin: .7em 0; }
.md-body ul, .md-body ol { padding-left: 1.6em; }
.md-body li + li { margin-top: .2em; }
.md-body pre { font-family: var(--mono); font-size: var(--fs-s); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-s); padding: 10px 12px; overflow-x: auto; }
.md-body :not(pre) > code { font-family: var(--mono); font-size: .88em; background: var(--surface-2); padding: .1em .35em; border-radius: 4px; }
.md-body blockquote { margin-left: 0; padding: 0 1em; border-left: 3px solid var(--line-2); color: var(--ink-2); }
.md-body hr { border: 0; border-top: 1px solid var(--line); margin: 1.5em 0; }
.md-body img { max-width: 100%; height: auto; }
.md-body .md-table { overflow-x: auto; margin: .7em 0; }
.md-body .md-table table { border-collapse: collapse; font-size: var(--fs-s); }
.md-body .md-table th, .md-body .md-table td { border: 1px solid var(--line); padding: 5px 10px; text-align: left; vertical-align: top; }
.md-body .md-table th { background: var(--surface-2); }
.md-body li.md-task-item { list-style: none; }
.md-body li.md-task-item .md-task { margin: 0 .35em 0 -1.35em; vertical-align: middle; }
.md-body .md-alert { border-left-color: var(--accent); }
.md-body .md-alert-title { font-weight: 600; color: var(--accent); margin-bottom: .2em; }
.md-body .md-alert-warning, .md-body .md-alert-important { border-left-color: var(--warn); }
.md-body .md-alert-warning .md-alert-title, .md-body .md-alert-important .md-alert-title { color: var(--warn); }
.md-body .md-alert-caution { border-left-color: var(--bad); }
.md-body .md-alert-caution .md-alert-title { color: var(--bad); }
.md-body .md-math { overflow-x: auto; margin: .8em 0; }
.md-body .md-math pre.md-tex { margin: 0; }
.md-body .md-broken { text-decoration: line-through wavy var(--bad); }
.md-body .md-nolink { border-bottom: 1px dotted var(--ink-3); }
.md-body .md-img { font-size: var(--fs-s); }
.md-body .md-mermaid-bad { border-color: var(--bad); }
.md-body .md-diagram { margin: .8em 0; overflow-x: auto; text-align: center; }
.md-body .md-diagram svg { max-width: 100%; height: auto; }
.md-body .md-front { margin-bottom: 1.2em; font-size: var(--fs-s); color: var(--ink-2); }
.md-body .footnotes { font-size: var(--fs-s); color: var(--ink-2); }
.md-preview .md-body { min-height: 200px; }
`;
