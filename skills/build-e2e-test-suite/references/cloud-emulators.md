# Official Cloud Emulators

Read when a journey crosses a managed cloud service. Use the provider's own emulator, in the order of [environment-strategies.md](environment-strategies.md): native process first, then the provider's image through Testcontainers. Claim only the semantics the emulator implements, and pin the version the run used. Checked against the providers' documentation in November 2026; confirm a row before relying on a detail it does not list.

## Google Cloud

| Service | Start (gcloud) | Component (`gcloud components install`) | apt/yum package | Client variable | Image |
|---|---|---|---|---|---|
| Pub/Sub | `gcloud beta emulators pubsub start --project=<id>` | `pubsub-emulator` | `google-cloud-cli-pubsub-emulator` | `PUBSUB_EMULATOR_HOST` | `gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators` |
| Firestore | `gcloud emulators firestore start` | see the product page | `google-cloud-cli-firestore-emulator` | `FIRESTORE_EMULATOR_HOST` | same `:emulators` image |
| Datastore | `gcloud beta emulators datastore start` | `cloud-datastore-emulator` | `google-cloud-cli-datastore-emulator` | `DATASTORE_EMULATOR_HOST` | same `:emulators` image |
| Bigtable | `gcloud beta emulators bigtable start` | see the product page | `google-cloud-cli-bigtable-emulator` | `BIGTABLE_EMULATOR_HOST` | same `:emulators` image |
| Spanner | `gcloud emulators spanner start` | `cloud-spanner-emulator` | `google-cloud-cli-spanner-emulator` | `SPANNER_EMULATOR_HOST` | `gcr.io/cloud-spanner-emulator/emulator` |

Sources: each product's emulator page under `docs.cloud.google.com/<product>/docs/emulator` (Datastore: `/datastore/docs/tools/datastore-emulator`), and `docs.cloud.google.com/sdk/docs/components`. Testcontainers for Go ships one package per service under `github.com/testcontainers/testcontainers-go/modules/gcloud/` (`pubsub`, `firestore`, `datastore`, `bigtable`, `spanner`), using those images.

### The launcher installs components

A `gcloud` alpha or beta command whose component is missing offers to install it, and a yes (or a non-interactive flag that answers for you) installs it before running. A harness never installs as a side effect:

1. Check the component is present before starting it: `gcloud components list --filter=id:<component> --show-versions` (or the apt/yum package, where the component manager is disabled).
2. Start the installed emulator, or run its binary under the SDK root (`$(gcloud info --format='value(installation.sdk_root)')/platform/<component>/...`) so nothing can be installed on the way.
3. When it is missing, follow *A missing prerequisite* in [environment-strategies.md](environment-strategies.md) with `gcloud components install <component>` (or the package) as the proposed command. Some emulators need a Java runtime: check it too.
4. Record the component version in the evidence, and report when `--show-versions` lists a newer one.

### Known differences

The Pub/Sub emulator forwards to dead-letter topics and supports ordering and retry policies; it has no IAM, no configurable retention, no subscription expiration, no protobuf schemas and no BigQuery delivery. Its documentation says nothing of exactly-once delivery: leave it out of what a run proves. To assert Ack and Nack, read [broker-acknowledgement.md](broker-acknowledgement.md).

## AWS

**AWS Emulator** is AWS's official local emulator, announced on 2026-11-11 (`aws.amazon.com/about-aws/whats-new/2026/11/aws-emulator-now-available/`; guide at `docs.aws.amazon.com/emulator/latest/userguide/`). It serves AWS SDK and CLI calls locally or in CI, with no AWS account, keeps state in memory, and answers an unsupported operation with HTTP 501. On Linux it installs from an RPM or Debian package and runs as a local process; on macOS and Windows it runs from a Docker image; both listen for HTTPS on `127.0.0.1:9297`. Point the SDK at it with the environment variables of the guide's "point your SDK" page, and read its fidelity page before claiming a behavior. Its service coverage comes from the AWS API models: check the operation the journey uses.

Long-standing single-service tools, when the journey needs only that service:

- **DynamoDB local:** JAR, Maven artifact or the `amazon/dynamodb-local` image; its page now recommends ExtendDB for new work.
- **Step Functions Local:** marked unsupported, without feature parity; AWS points to the TestState API instead.
- **SAM CLI** (`sam local invoke`): runs one Lambda function in a local container.

## Other clouds

Prefer the provider's documented emulator when one exists, and add a section here once a run has checked it against the provider's current documentation.
