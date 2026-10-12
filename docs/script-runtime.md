# Isolated JavaScript and TypeScript blocks

The initial script profile implements pure boolean graph functions. In Logic, add **JS / TS script**, connect both `a` and `b`, and edit **Script source** in Properties. The editor contains a function body, for example:

```typescript
const permitted: boolean = input.a && !input.b;
return permitted && nowMs >= 1000;
```

`input` is a frozen copy of two booleans. `nowMs` is the graph's monotonic evaluation time, or explicit virtual time during simulation. Live time is worker monotonic time, not elapsed time since graph activation. Return a boolean synchronously. Every call receives a fresh JavaScript context: globals, prototypes and local variables cannot persist between cycles. Use the existing timer/latch blocks for state. Numeric outputs, persistent script state, imports, promises, host I/O, Structured Text, full IDE diagnostics and script debugging remain future work.

A graph permits at most two script blocks, each with at most 16,384 UTF-8 source bytes. Missing or invalid upstream values skip execution and propagate Bad quality. TypeScript is transpiled and syntax-checked; this is not complete static type checking. The runtime enforces boolean output independently. Source must remain a single function body; attempts to append top-level statements are rejected.

## Preparation, simulation and execution

Saving incomplete drafts does not require a running interpreter. Preparation validates each script in the isolated service and commits the prepared snapshot/audit only after successful validation. Function bodies are not invoked during preparation. Invalid scripts return 422; an absent or unavailable service returns 503. Syntax validation does not prove that a function terminates or returns the correct type when called.

The web simulation bench samples script graphs six times from 0 to 5000 ms in 1000 ms increments. The API allows at most ten steps, checks an elapsed three-second budget between steps and bounds each service call to one second. The last step can extend the total beyond three seconds by at most two bounded service calls. Simulation never submits equipment commands.

Activation validates scripts again before pausing the previous generation or transferring output ownership. Script graphs wait at least 1000 ms after each completed cycle; ordinary graphs retain their 100 ms interval. There is no catch-up or overlapping cycle. A runtime script error, overload, invalid result or deadline faults the task, revokes its output authority and stops its devices through the normal runtime path. Late results after stop or deadline cannot submit commands. Recovery requires explicit operator activation; no intent is retried automatically. Device watchdogs and independent protective hardware remain necessary.

## Isolation and resource limits

API and runtime processes send copied values to `script-runner` over a private Docker network. They do not evaluate user source. The runner exposes no host port and has no database credentials, controller credentials, workspace secrets or Docker socket. Its mounts contain only its package, the root package manifest and read-only dependencies. The service runs as UID 1000 with a read-only root, dropped capabilities, no-new-privileges, an internal network, a 512 MiB container memory limit, one CPU and 64 processes. Its 64 MiB temporary filesystem is non-executable. Ordinary source edits use a read-only bind mount and hot reload.

Inside the service, one Node worker transpiles code and runs QuickJS WebAssembly. Only QuickJS values enter the guest; Node APIs are never injected. `Date` and `Math.random` are unavailable; no filesystem/network/timer callbacks are supplied. Dynamic JavaScript constructors remain inside the guest. The guest heap is limited to 8 MiB and stack to 256 KiB, with a 100 ms interrupt deadline. Transpilation runs under the outer worker's limit; its cache holds at most 32 compiled bodies.

The parent applies a separate 500 ms wall deadline and terminates/replaces the worker after an overrun or cancellation. This outer deadline matters because interpreter interrupt handlers do not cover every native operation. The HTTP queue permits four outstanding requests, processes them serially and expires each after 1500 ms from enqueue. Clients wait at most 1000 ms without retries. Queue overload or worker recovery can fault a live graph; the initial service is a bounded engineering profile, not a throughput guarantee for thousands of script blocks. A worker crash discards its current request and does not replay it. Container/OS scheduling is not hard real time.

The endpoint is configured by the operator through `APCS_SCRIPT_URL`, never from a graph. The internal service trusts its isolated application network; it is not a public multi-tenant execution API. Isolation tests cover missing host capabilities, fresh contexts, immutable input, bad result types, runaway loops, recursion, memory pressure and a long native operation followed by worker recovery. These tests are not a formal sandbox certification.

## Dependencies and offline operation

QuickJS/Emscripten 0.32.0, TypeScript 5.9.3 and the exact transitive versions are pinned in the lockfile. The WebAssembly payload ships in the local dependency store; no CDN, browser download or network package installation occurs during execution. The runner reuses the existing Node tool image. Offline bundle overrides alias it to the bundled image, without adding an image family. The historical firmware distribution drill predates this feature; it is not evidence of a fresh script-enabled bundle installation.

Primary references: [QuickJS/Emscripten project and capabilities](https://github.com/justjake/quickjs-emscripten), [runtime memory and interrupt APIs](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md), and [documented interrupt gap for native array operations](https://github.com/justjake/quickjs-emscripten/issues/219). The separate process/container deadlines are Open APCS design decisions based on that limitation.
