# Editor tools and embedded trends

P3 keeps graph/HMI documents portable and versioned while adding deliberate authoring actions. Duplicate selected copies a graph block without inventing connections. Duplicating an HMI group includes its descendants and remaps group IDs. Auto-arrange orders graph blocks by dependency; snap aligns HMI element positions to a 20-pixel grid. All actions participate in the existing undo/redo stack and leave prepared revisions unchanged. Invalid duplicates, size limits and cycles are rejected by the same document validators used by persistence.

A trend is a bound HMI element for a numeric or boolean signal. Its visible window is configurable and bounded. Prepared operator screens display a periodically refreshed archive view with the current quality, an explicit loading/error/empty state and a link to inspect the underlying signal history. A failed refresh cannot present old observations as live. Rendering reuses the existing historian's gap-aware chart semantics and preserves unavailable intervals. The graph is a visualization of bounded loaded observations, not a guarantee that every sample in a long window is displayed.

Editor canvas rendering, shared document types and authoring transformations belong in dedicated feature/domain modules. HTTP document validation and project binding checks are shared by normal persistence and later AI proposals. Refactoring must preserve existing simulation, revision, command ownership and operator-control behavior; the existing browser/integration gate remains mandatory.

Acceptance: duplicate/undo/redo, group subtree identity, dependency layout, snap, chart binding and window validation, persisted chart in a prepared screen, Good/Disconnected transitions, empty history, errors and responsive rendering. No new chart action issues equipment commands.

Trends allow 10–86,400 seconds, at most eight per screen, and a minimum design size of 320 × 200. Each refresh loads at most 1,000 observations with a three-second request deadline; the next round starts two seconds after completion. Phone operator views move trends into responsive cards while keeping the editable scene coordinates intact. See [code structure](code-structure.md).

Embedded plot geometry follows its rendered SVG dimensions, retaining readable axis labels at phone widths. Timestamps on compact axes use local time-of-day; the full history inspector retains dated observations. The original archive quality/gap semantics are shared, and resizing does not invent interpolated values.
