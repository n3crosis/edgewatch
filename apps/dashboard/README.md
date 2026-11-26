# EdgeWatch dashboard

React + Vite + Tailwind CSS v4, built on **Kumo UI** (`@cloudflare/kumo`, Cloudflare's component library; docs: https://kumo-ui.com,
source: https://github.com/cloudflare/kumo). Kumo is the design system of record: all UI controls come from Kumo
(granular imports such as `@cloudflare/kumo/components/table`), icons from `@phosphor-icons/react`, class merging via
`cn` from `@cloudflare/kumo/utils`, and colors from Kumo's semantic tokens (`bg-kumo-*`, `text-kumo-*`, `border-kumo-hairline`).
Dark mode is set with `data-mode="dark"` on `<html>`.

Setup follows https://kumo-ui.com/installation: `src/index.css` adds `@source` for Kumo's dist, imports
`@cloudflare/kumo/styles/tailwind` before `tailwindcss`, and `#root` has `isolation: isolate` for portaled popups.
`LinkProvider` maps Kumo `LinkButton` to react-router.

| Kumo component | Used for |
| --- | --- |
| `LayerCard` | panels, stat cards, setup guides |
| `Table` | traces, exceptions, queries, routes, keys |
| `Badge` | status, execution source, handled/unhandled, data source |
| `Button` / `LinkButton` | navigation, back links, pagination, copy |
| `Tabs` (segmented) | time range, handled filter, query sort |
| `Tabs` (underline) | trace detail and setup tabs |
| `Select` | trace type and status filters |
| `InputGroup` | search boxes |
| `Switch` | live polling toggle |
| `Tooltip` | chart bars, waterfall spans, SQL, data source |
| `Dialog` | waterfall span details |
| `Banner`, `Empty`, `SkeletonLine` | error, empty and loading states |

Not from Kumo: the bar/line/sparkline charts and the trace waterfall are small custom SVG/div components (Kumo's
`TimeseriesChart` needs the optional `echarts` peer, which was not added). Span colors in the waterfall use plain Tailwind
palette colors to tell span types apart; Kumo has no semantic token per span type.

```bash
bun run dev                                 # seed data
VITE_API_URL=http://127.0.0.1:8788 VITE_PROJECT_ID=demo bun run dev   # asks for a read key on first load
```
