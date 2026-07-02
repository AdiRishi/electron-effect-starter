# Architecture Decision Records

Architecture Decision Records document decisions that future maintainers or agents may be tempted to revisit without the current context.

ADRs in this repository live in this directory and use sequential numbering: `0001-slug.md`, `0002-slug.md`, and so on. Keep each ADR small: a title and a short paragraph explaining the context, the decision, and why it was chosen is usually enough.

Optional sections such as status, considered options, and consequences should only be added when they genuinely help. The point is recording "that a decision was made and why", not filling a template.

Create a new ADR when a decision is hard to reverse, surprising without context, and the result of a real trade-off. Good candidates include architectural shape, integration patterns, platform choices, scope boundaries, deliberate deviations from the obvious path, hidden constraints, or non-obvious rejected alternatives. Many ADRs here record deliberate deviations from — or deliberate adoptions of — patterns in the T3 Code reference repository, which this starter treats as its baseline for best practices.

When an ADR no longer describes the system, update or replace that ADR so the directory remains a current architecture guide. Do not keep superseded records solely for historical tracking.

This format follows the ADR guidance from Matt Pocock's skills repo: [domain-model/ADR-FORMAT.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/grill-with-docs/ADR-FORMAT.md).
