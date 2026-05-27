# Contributing

This is a living document repo. Contributions that improve accuracy, add missing context, or share alternative patterns are welcome.

## What to contribute

- **Corrections**: If a pattern description is wrong or misleading, open an issue with the specific claim and why it's incorrect.
- **Alternatives**: If you solved the same problem differently and it held up in production, open a PR adding an "Alternative approach" section to the relevant doc.
- **New patterns**: If you have a well-understood pattern not covered here, open an issue first to discuss before writing the doc.
- **Diagram improvements**: Mermaid source is in `diagrams/`. Cleaner diagrams always welcome.

## What not to contribute

- Framework-specific tutorials (this repo stays framework-agnostic)
- Patterns that haven't been validated in production
- Promotional content for specific tools or providers

## Format

Each doc follows this structure:
1. The problem (concrete, not abstract)
2. Why the naïve solution fails
3. The pattern (with code or pseudocode where it helps)
4. Trade-offs (honest about when this pattern is wrong)
5. Where this came from (real system, not invented)

Keep writing direct. No filler sentences. If a sentence doesn't add information, delete it.
