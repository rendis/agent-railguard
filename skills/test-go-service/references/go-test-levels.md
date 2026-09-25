# Selecting a Go Test Level

## Choose one primary signal

| Risk or seam | Primary level | Infrastructure |
|---|---|---|
| Invariant, value object, or pure function | Domain unit test | None |
| Use-case orchestration and error classification | Service test through fake ports | None |
| Decoder, mapper, or input handler | Primary-adapter test | Representative request or event |
| Client serialization, timeout, or mapping | Secondary-adapter test | In-memory server when sufficient |
| Real driver, query, broker, or storage semantics | Integration | Isolated real dependency or emulator |
| Several interchangeable port implementations | Reusable contract suite | One factory per implementation |
| Runtime assembled in one process | Component test | Minimum controlled dependencies |
| Observed flow across the complete system | Outside this skill | `build-e2e-test-suite` |

- **Domain:** test constructors, invariants, transitions, and policies with known values and no infrastructure. Use the same package for deliberate internal contracts, an external package when the public API is the real seam.
- **Service:** use small fakes implementing the ports the design requires. Assert contractual results and effects; assert order only when guaranteed. Cover happy path, validation, and relevant error categories.
- **Primary adapter:** test binding/decoding, technical validation, identity, mapping, correlation, and protocol response. Keep exhaustive business-rule combinations in the owning domain level.
- **Secondary adapter:** test external request, headers, encoding, timeout, cancellation, response mapping, and error translation. Use `httptest` or another in-memory server when it exposes the network contract.
- **Integration:** use it when real implementation behavior is the risk — isolation, transactions, precision, indexes, emulator, protocol, lifecycle. Prepare data through supported interfaces, isolate each test, clean up after failures.
- **Contract:** a suite that receives a port factory and runs the same observable behavior against each implementation, alongside technology-specific tests.
- **Component:** assemble several modules in one process and test through the component's public port. Keep browsers, deployed environments, and complete topologies out.

A secondary level must detect a defect class the primary level cannot observe. Repeating a case at another layer needs a distinct risk, not merely higher coverage.
