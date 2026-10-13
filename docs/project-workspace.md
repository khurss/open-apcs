# Project workspace and demo

P2 adds a project entry point without changing the command authority model. A project row is a keyboard-accessible link. Its URL identifies the selected project and section, survives reload, and supports browser back/forward. Unsaved editor changes require a discard decision before navigation.

Device and signal catalog requests support an optional project UUID filter applied before pagination. A bounded search query filters names in SQL. Foreign project filters return no data. The selected context is visible above project sections. Project metadata and catalog names can be edited with an `If-Match` revision; concurrent edits return 412, and successful changes are audited. Renaming a signal does not alter its wire identity, type, direction or live value. Runtime parameters and physical GPIO review stay in their existing workflows.

The demo installer creates one demonstration per owner in a transaction, serializing concurrent requests. Reopening the installer returns the same IDs and never overwrites user edits. The demo consists of a virtual LED, a virtual thermal process, named signals, prepared LED/PID logic and prepared operator screens. It starts stopped. Controls reuse authenticated, audited virtual runtime and graph APIs. Installation never starts a runtime, sends a command, or provisions physical hardware.

The UI explains the workflow: install/open the demo, start its virtual devices, inspect a prepared graph, activate the reviewed revision, and operate its prepared screen. Stop the graph before stopping its devices. Users can also inspect and simulate documents without starting devices. A failed step stays visible; the UI must not claim the entire demo is running merely because the install request succeeded.

Acceptance includes concurrent installation, owner isolation, unchanged prepared snapshots on reopen, project filtering before cursor pagination, stale metadata revisions, keyboard project links, reload/back, the running virtual process, operator-screen readings and explicit stop. Docker browser tests use isolated fixtures; the LAN demo uses the same public workflows.
