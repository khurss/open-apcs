# Repository instructions

- Keep authored repository content in English: specifications, documentation, source comments, UI text, filenames, and commit messages. Preserve Unicode support for user-defined data. Run the language check before committing.
- Use TDD for behavior changes: observe a meaningful failing test, implement the behavior, then run the relevant checks. Record verified results and limitations in the TDD log.
- Run all application tests and TypeScript checks in Docker. Use bind mounts and watch/hot reload during development. Rebuild images only when their toolchain or Dockerfile changes.
- Before completing a phase, update its specifications and status, run `make test`, and commit the reviewed changes with an English message. Push completed phases to `https://github.com/khurss/open-apcs.git`, as authorized by the repository owner. Do not force-push or rewrite unrelated history.
- Describe partial milestones honestly. Passing library tests does not mean the web application, hardware integration, offline bundle, or full phase is complete.
- The legacy `old-code` directory is an external, read-only source of functional ideas. Do not publish its source or assets as part of this repository.
- The open-source license is still undecided. Do not invent a license choice.
