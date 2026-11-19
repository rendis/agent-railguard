# Observing Ack and Nack on a Broker

A consumer's public outcome for a message is what the broker receives: an acknowledgement (Ack) settles the message, a negative acknowledgement (Nack) asks for redelivery. Assert it **on the wire**, between the service and the real broker or its official emulator, never from the consumer's logs or internal state.

## Why indirect designs pass falsely

- **Dead-letter policy.** "Nack means the message reaches the dead-letter topic after N attempts; Ack means it never does" cannot tell an Ack from no answer at all. A message the service neither acknowledges nor rejects stays leased: the client keeps extending its deadline, so it never dead-letters and the Ack scenario passes with the Ack removed.
- **Stopping the consumer and pulling what is left.** What remains depends on lease duration, extension and client settings, not on the service's decision.
- **Sentinel messages.** A second message proving "the first one was processed" proves ordering at best, not the decision on the first.

Prove the design with mutants before trusting it: remove the Ack, turn the Ack into a Nack, remove the Nack. Each must turn the scenario red.

## The recording proxy

Run a transparent proxy of the broker's consumer API between the service and the emulator, one per scenario:

1. Point the service at the proxy the way it already finds the emulator (for example an `*_EMULATOR_HOST` variable), so production code does not change.
2. Forward every call unchanged to the emulator, unary and streaming, in both directions.
3. Record per message ID: each delivery, each acknowledgement, and each negative acknowledgement as the protocol spells it (for Google Pub/Sub, `Acknowledge` is the Ack and `ModifyAckDeadline` with a deadline of 0 is the Nack, in unary calls and inside `StreamingPull` requests).
4. Answer a call the proxy does not forward with an explicit `Unimplemented` error, so an unexpected call fails visibly instead of passing.

Assert, under a deadline and with no fixed sleep:

| Outcome | Holds when |
| --- | --- |
| Ack | exactly one delivery, at least one Ack, no Nack |
| Nack | at least one Nack, no Ack, and the redelivery is rejected again |

The emulator stays the real broker; the proxy only observes. Writing it in the test runner's language with the broker's generated client stubs keeps it inside the suite, with no extra process to orchestrate.

## Declare the limits

Record in the execution contract what the proxy cannot see: calls it does not forward, a client configured with an explicit endpoint that bypasses the emulator variable, an Ack and a Nack of the same message after the scenario's cut-off, and delivery semantics the emulator does not implement (exactly-once delivery, for example). Revalidate them when the consumer's client configuration changes.
