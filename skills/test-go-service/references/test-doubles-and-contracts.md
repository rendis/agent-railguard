# Test Doubles and Contracts

## Choose the minimum double

| Double | Use | Constraint |
|---|---|---|
| Stub | Return a fixed boundary response | Do not model complex logic |
| Fake | Implement simple, verifiable port behavior | Do not become a second production implementation |
| Spy | Capture a contractual effect with no other observable output | Avoid internal order and call counts |
| Mock | Simulate an expensive or remote boundary with a contractual expectation | Use only when the interaction protocol is the guarantee |

Prefer fakes or in-memory servers at external ports, and test internal types or pure functions directly through results.

Design from the consumer: create an interface because the consumer needs a real capability, keep methods and data minimal, build the double in the test package unless a contract suite shares it, and configure failures through port categories rather than provider errors. Prefer results, queryable state, or public messages; capture arguments only when they belong to the contract (a sent body, a preserved source ID, a guaranteed single invocation), and assert order only when every equivalent implementation must preserve it.

For contract suites, write one function taking `testing.T` and an isolated factory, and run the same semantics against every implementation alongside technology-specific tests beside each adapter. The factory must create isolated state, return the public interface, register cleanup, expose only necessary setup capabilities, and never leak the driver into the contract test.

Prefer an isolated real implementation when risk lives in queries, precision, transactions, protocol, or emulation. Choose Testcontainers, Compose, an emulator, or a local process from observed project conventions.
