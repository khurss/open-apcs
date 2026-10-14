# Virtual multichannel input bank

This engineering profile supplies real MQTT traffic for multichannel monitoring,
logic, history and future capacity qualification. It is a synthetic device,
not a physical sensor driver or a claim of 200-signal endurance acceptance.

## Operator workflow

In Devices, select **Virtual input bank**, choose **Numeric inputs** from 1 to
15, and create the device. Registration atomically creates one boolean virtual
LED output and the requested float64 inputs. The default is 15 inputs. Start
simulator explicitly, then open Signals to inspect changing values and history.
Input controls remain disabled. Numeric inputs can bind to Analog input blocks,
HMI numeric values, trends and numeric alarms through the existing contracts.
The virtual LED retains the audited command, ownership and recovery workflow.

Stopping the device disconnects all of its signals. Graphs using unavailable
inputs fault under the normal quality rules; restart never automatically
reactivates a graph. A new simulator session has a new boot ID and begins with
its virtual output OFF. This profile cannot commission a physical GPIO or use
the private physical broker configuration.

## Catalog and telemetry contract

`POST /api/v1/devices` accepts `kind: "virtual-input-bank"` and optional integer
`inputCount` in 1–15. Other kinds reject `inputCount`. The response includes
`signalId`, `inputCount` and `inputSignalIds`. Project ownership, CSRF and audit
are required; an audit failure rolls back the entire device and all channels.
Migration 013 adds the profile without changing existing device records.

Input IDs are generated and sorted before assigning initial channel names
`<device>.input-01` through `<device>.input-15`. Runtime channel order uses these
UUIDs, so renaming a signal does not change its generated value. Channel count
is fixed after registration in this delivery. Existing names remain editable.

The private simulation namespace publishes one non-retained QoS 1 bank frame
on the device's `out/inputs` topic. Frames contain exactly `v`, `bootId`,
`sequence` and `values`; version is 1. There are exactly as many values as
configured inputs. The entire payload is bounded to 2048 bytes and validated
before any signal is ingested. Values must be finite numbers in each channel's
range. Retained, wrong-QoS, malformed, foreign-session and duplicate/out-of-order
frames are rejected. This namespace is an internal simulator transport, not an
API for arbitrary external MQTT publishers.

Channel `i`, starting at zero, produces `100*i + sequence % 100`. The initial
sequence is zero. Values therefore change predictably within disjoint ranges
and wrap every 100 publications. Source time is unavailable (`null`); server
receive time, boot and sequence supply the ordering evidence. One frame is
scheduled per second on a monotonic grid, with elapsed slots skipped and no
overlap/catch-up burst. This is best-effort simulation, not guaranteed real-time
sampling. Publication is bounded to one second; transport failure disconnects
the bank and faults its runtime. Signal freshness remains three seconds.

## Verification and next capacity step

Docker tests exercise bounded/atomic registration, ownership/CSRF, audit
rollback, complete-frame validation, replay rejection, actual MQTT transport
loss, all-channel history and disconnect, and numeric graph control of the
virtual output. Chromium creates a 15-input bank, observes changing values,
checks disabled input controls and verifies disconnection after stop.

A functional Docker scenario runs **200 active signals across 13 virtual
banks** (12 banks with 15 inputs and one with seven, plus 13 outputs), verifies
Good samples in two 100-signal reads, archives all channels and disconnects them
on stop. This short automated scenario does not measure sustained throughput,
UI latency under load, memory growth or physical-device performance.

The existing limit of 16 active devices is unchanged. A future mixed 200-signal
L0 fixture can use 12 full banks, one six-input bank and the physical LED:
186 numeric inputs plus 14 boolean outputs across 14 devices. Its expected
telemetry sequences, archive-change count, page-wide UI observations and fault
cleanup need a dedicated load runner before the one-hour gate can be claimed.
The existing 16-output L0 fixture and historical evidence remain unchanged.
