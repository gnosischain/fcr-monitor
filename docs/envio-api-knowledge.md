# Bridging Time from the Envio API: Knowledge Base

Use this guide to compute **bridging time** for the Gnosis bridges (xDAI bridge and AMB/OmniBridge) from the
Envio GraphQL indexer that powers the Bridge Explorer.

| Direction                                        | Start event (source chain)              | End event (destination / home chain) |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------ |
| **Ethereum → Gnosis** (`initiatorNetwork = 1`)   | `UserRequestForAffirmation` on Ethereum | `AffirmationCompleted` on Gnosis     |
| **Gnosis → Ethereum** (`initiatorNetwork = 100`) | `UserRequestForSignature` on Gnosis     | `CollectedSignatures` on Gnosis      |

> ⚠️ **The most important rule:** for Gnosis → Ethereum, `execution.timestamp` is **not** the end time.
> `execution` holds the Ethereum `RelayedMessage` (the user's _claim_, which can happen days later or never).
> The indexer does **not** store a `CollectedSignatures` timestamp. Derive it from the **latest validation**.
> See [§4.2](#42-gnosis--ethereum).

Sources of truth:

- Indexer schema: `envio-indexer/schema.graphql`
- Indexed events and contracts: `envio-indexer/config.yaml`
- Event handlers: `envio-indexer/src/eventHandlers/{XDAI,AMB}/{foreignToHome,homeToForeign}.ts`, `AMB/omnibridgeMediator.ts`
- Frontend query: `app/src/queries/transactions.ts`; filter builder: `app/src/utils/transactionsQuery.ts`; mapping: `app/src/utils/transactions.ts`
- Frontend proxy: `app/pages/api/graphql.ts`

---

## 1. How the app reads the Envio API

```
Browser ──POST /api/graphql──▶ Next.js proxy (app/pages/api/graphql.ts) ──▶ ENVIO_INDEXER_URL (Hasura GraphQL)
                                   + Authorization: Bearer ENVIO_INDEXER_TOKEN
```

- The client (`app/src/constants/config/indexer.ts`) uses `graphql-request` against the same-origin route `/api/graphql`.
- The proxy uses an **allow-list**. It forwards only the exact documents `ENVIO_TRANSACTIONS_QUERY`,
  `ENVIO_VALIDATORS_QUERY` and `ENVIO_VALIDATORS_ACTIVITY_QUERY`, compared after whitespace normalisation.
  Any other query, including a custom bridging-time query, an introspection query or a batch, gets a `403 Operation not allowed`.
  - **To run custom queries** (for example, ones that use nested `order_by` on `validations`), call the indexer directly at
    `ENVIO_INDEXER_URL` (`app/.env.example`) with header `Authorization: Bearer <ENVIO_INDEXER_TOKEN>`.
    The local dev indexer is at `http://localhost:8080/v1/graphql` (Hasura console password `testing`).
  - **Through the proxy**, you can only use `ENVIO_TRANSACTIONS_QUERY` (reproduced below) and vary its
    variables `$where`, `$order_by`, `$limit` and `$offset`. That is enough to compute bridging time, because it returns
    `timestamp`, `execution { timestamp }` and `validations { timestamp }`.
- The API is Hasura-style: `Transaction(where: Transaction_bool_exp, order_by: [...], limit, offset)`, with
  operators `_eq`, `_in`, `_gte`, `_lte`, `_and`, `_or`, `_is_null` and so on.
- The app fetches one page of 500 rows (`PAGE_SIZE`), sorted by `timestamp desc`, and polls every 5 s. For analytics, paginate
  with `limit`/`offset` and keep `limit` ≤ 1000.

The allow-listed query (`app/src/queries/transactions.ts`):

```graphql
query EnvioTransactions(
  $where: Transaction_bool_exp
  $order_by: [Transaction_order_by!]
  $limit: Int
  $offset: Int
) {
  Transaction(
    where: $where
    order_by: $order_by
    limit: $limit
    offset: $offset
  ) {
    id
    messageId
    bridgeType
    transactionHash
    timestamp
    initiatorNetwork
    initiator
    initiatorToken
    initiatorAmount
    receiverNetwork
    receiver
    receiverToken
    receiverAmount
    transactionStatus
    execution {
      id
      transactionHash
      timestamp
      executorAddress
    }
    validations {
      id
      transactionHash
      timestamp
      validatorAddress
    }
  }
}
```

---

## 2. Data schema (`envio-indexer/schema.graphql`)

All timestamps are **block timestamps in Unix seconds** (`BigInt`). The value may arrive as a string or a number in JSON, so cast it with `Number(...)`.
Addresses are **lowercased** (`address_format: lowercase`).

### `Transaction` (one row per bridge message)

| Field                                            | Meaning                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` / `messageId`                               | Unique key. AMB: the AMB `messageId`. xDAI post-Hashi: `combineNonceAndChainId(nonce, sourceChainId)` (the first 4 bytes are replaced by the chain id). xDAI pre-Hashi: the source tx hash. |
| `nonce`                                          | Raw nonce (xDAI) or `messageId` (AMB)                                                                                                                                                       |
| `bridgeType`                                     | `XDAI` or `AMB`                                                                                                                                                                             |
| `transactionHash`                                | Hash of the **source-chain** tx that initiated the bridge. Can be `null` in rare AMB rows created by a mediator event.                                                                      |
| `timestamp`                                      | **Block timestamp of the initiating event on the source chain** (= start time)                                                                                                              |
| `initiatorNetwork`                               | `1` (Ethereum) or `100` (Gnosis). This field gives the **direction**.                                                                                                                       |
| `receiverNetwork`                                | The opposite chain                                                                                                                                                                          |
| `initiator`, `initiatorToken`, `initiatorAmount` | Sender side                                                                                                                                                                                 |
| `receiver`, `receiverToken`, `receiverAmount`    | Receiver side                                                                                                                                                                               |
| `transactionStatus`                              | `INITIATED` → `COLLECTING` → `UNCLAIMED` (GC→ETH only) → `COMPLETED`; or `ERROR` (AMB execution with `status=false`)                                                                        |
| `validations`                                    | `[TransactionValidation]`: one row per validator signature, always on **Gnosis**                                                                                                            |
| `execution`                                      | `TransactionExecution`: the final execution event (see below for its meaning in each direction)                                                                                             |

### `TransactionValidation`

`id` (`${txId}-${validator}`), `transactionHash` (Gnosis tx of the signature), `validatorAddress`, `timestamp`.

### `TransactionExecution`

`id`, `transactionHash`, `timestamp`, `executorAddress` (`executor` → `Validator`).

### Helper tables (not needed for timing)

`Validator`, `DaiOrUsdsTransfer` (enriches the xDAI ETH→GC sender and token), `AMBTransfer` (OmniBridge token, sender, recipient and amount, keyed by `messageId`).

### Status semantics

| Status       | ETH → GC                                     | GC → ETH                                                                             |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `INITIATED`  | `UserRequestForAffirmation` seen             | `UserRequestForSignature` seen                                                       |
| `COLLECTING` | ≥1 `SignedForAffirmation`                    | ≥1 `SignedForUserRequest`                                                            |
| `UNCLAIMED`  | n/a                                          | `CollectedSignatures` seen (threshold reached, waiting for the user to claim on ETH) |
| `COMPLETED`  | `AffirmationCompleted` (status=true for AMB) | `RelayedMessage` on Ethereum (claimed)                                               |
| `ERROR`      | AMB `AffirmationCompleted(status=false)`     | AMB `RelayedMessage(status=false)`                                                   |

---

## 3. Which events map to which fields

### 3.1 Ethereum → Gnosis (`initiatorNetwork = 1`)

| Step          | Chain | Contract                                         | Event                                                                                                      | Indexer effect                                                                                        |
| ------------- | ----- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 0             | ETH   | DAI / USDS token                                 | `Transfer(to = bridge / router)`                                                                           | `DaiOrUsdsTransfer` (xDAI sender enrichment only)                                                     |
| **1 (start)** | ETH   | xDAI `XDAIForeign` `0x4aa4…5016`                 | `UserRequestForAffirmation(recipient, value, nonce)` (current), plus the pre-Hashi variant without `nonce` | Creates `Transaction` with **`timestamp` = this block's timestamp**, `INITIATED`                      |
| **1 (start)** | ETH   | AMB `AMBForeign` `0x4C36…E64e`                   | `UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData)`                                  | Creates `Transaction` (only OmniBridge token flows) with **`timestamp`**                              |
| 2             | GC    | xDAI home `0x7301…0AA6` / AMB home `0x75Df…bb59` | `SignedForAffirmation`                                                                                     | `TransactionValidation` row, status `COLLECTING`                                                      |
| **3 (end)**   | GC    | xDAI home / AMB home                             | `AffirmationCompleted`                                                                                     | `TransactionExecution` with **`timestamp` = this block's timestamp**, status `COMPLETED` (or `ERROR`) |

The `Transaction` row is created **only once**, by the first handler that sees the message. Handlers later in the flow never overwrite
`Transaction.timestamp` (`if (!tx)` guards). The OmniBridge mediator event `TokensBridgingInitiated` is emitted in
the same Ethereum tx as `UserRequestForAffirmation`, so whichever handler creates the row, the start timestamp is the same block.
`Transaction.timestamp` is therefore the timestamp of the first (and only) `UserRequestForAffirmation`.

### 3.2 Gnosis → Ethereum (`initiatorNetwork = 100`)

| Step          | Chain | Contract                   | Event                                                                                         | Indexer effect                                                                          |
| ------------- | ----- | -------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **1 (start)** | GC    | xDAI home `0x7301…0AA6`    | `UserRequestForSignature(recipient, value, nonce, token)` (current), plus two legacy variants | Creates `Transaction` with **`timestamp`**, `INITIATED`                                 |
| **1 (start)** | GC    | AMB home `0x75Df…bb59`     | `UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)`                       | Creates `Transaction` (OmniBridge token flows) with **`timestamp`**                     |
| 2             | GC    | xDAI / AMB home            | `SignedForUserRequest(signer, messageHash)`                                                   | `TransactionValidation` row (`timestamp` = this block), status `COLLECTING`             |
| **3 (end)**   | GC    | xDAI / AMB home            | `CollectedSignatures(authorityResponsibleForRelay, messageHash, n)`                           | **Only flips status to `UNCLAIMED`. No timestamp or tx hash is stored.**                |
| 4             | ETH   | xDAI foreign / AMB foreign | `RelayedMessage` (user/relayer claims)                                                        | `TransactionExecution` (`timestamp` = **ETH claim time**), status `COMPLETED` / `ERROR` |

For GC→ETH, the xDAI `UserRequestForSignature` handler does overwrite an existing row, but with the same event's
timestamp, so `Transaction.timestamp` is still the start time.

---

## 4. Computing bridging time

### 4.1 Ethereum → Gnosis

```
bridgingTime = execution.timestamp − Transaction.timestamp
             = AffirmationCompleted (GC block ts) − UserRequestForAffirmation (ETH block ts)
```

Filter:

```json
{
  "where": {
    "_and": [
      { "initiatorNetwork": { "_eq": 1 } },
      { "transactionStatus": { "_eq": "COMPLETED" } },
      { "execution": { "timestamp": { "_is_null": false } } },
      { "timestamp": { "_gte": 1759276800 } },
      { "timestamp": { "_lt": 1759881600 } }
    ]
  },
  "order_by": [{ "timestamp": "desc" }],
  "limit": 1000,
  "offset": 0
}
```

Add `{ "bridgeType": { "_eq": "XDAI" } }` or `"AMB"` to split by bridge. Decide whether to include `ERROR` rows.
The affirmation was still executed, but the message call failed.

### 4.2 Gnosis → Ethereum

```
bridgingTime = collectedSignaturesTimestamp − Transaction.timestamp
             = CollectedSignatures (GC block ts) − UserRequestForSignature (GC block ts)
collectedSignaturesTimestamp = max(validations[].timestamp)
```

**Why `max(validations.timestamp)` equals the `CollectedSignatures` time:** in the home bridge contracts
(`BasicHomeBridge.submitSignature` / `BasicHomeAMB.submitSignature`), the validator whose signature reaches
`requiredSignatures` emits `SignedForUserRequest` and `CollectedSignatures` **in the same transaction**. After that,
the message is marked as processed (`markAsProcessed`), and any further `submitSignature` for it reverts. So the
threshold-reaching signature is always the last `SignedForUserRequest`, and its `TransactionValidation.timestamp`
(and `transactionHash`) are exactly the `CollectedSignatures` block timestamp (and tx hash).

Only use rows where the threshold is known to have been reached:

```json
{
  "where": {
    "_and": [
      { "initiatorNetwork": { "_eq": 100 } },
      { "transactionStatus": { "_in": ["UNCLAIMED", "COMPLETED", "ERROR"] } },
      { "timestamp": { "_gte": 1759276800 } },
      { "timestamp": { "_lt": 1759881600 } }
    ]
  },
  "order_by": [{ "timestamp": "desc" }],
  "limit": 1000,
  "offset": 0
}
```

**Do NOT** use `execution.timestamp` for this direction. That value is the Ethereum claim (`RelayedMessage`), which depends on the user.
If you need "time until funds received on Ethereum" as a separate metric, that is `execution.timestamp − timestamp`.

If you query the indexer directly (not through the proxy), you can fetch only the last signature:

```graphql
query GcToEthBridgingTime(
  $from: numeric!
  $to: numeric!
  $limit: Int!
  $offset: Int!
) {
  Transaction(
    where: {
      initiatorNetwork: { _eq: 100 }
      transactionStatus: { _in: [UNCLAIMED, COMPLETED, ERROR] }
      timestamp: { _gte: $from, _lt: $to }
    }
    order_by: { timestamp: desc }
    limit: $limit
    offset: $offset
  ) {
    id
    bridgeType
    transactionHash
    timestamp
    validations(order_by: { timestamp: desc }, limit: 1) {
      timestamp
      transactionHash
    }
  }
}
```

(The `numeric` scalar name for `BigInt` and the enum literal syntax depend on the Hasura version. If the query fails, check them with a
Hasura console introspection on the direct endpoint.)

### 4.3 Reference implementation (TypeScript)

```ts
type Row = {
  id: string;
  bridgeType: "XDAI" | "AMB";
  initiatorNetwork: number;
  transactionHash: string | null;
  timestamp: string | number;
  transactionStatus:
    | "INITIATED"
    | "COLLECTING"
    | "UNCLAIMED"
    | "COMPLETED"
    | "ERROR";
  execution: { timestamp: string | number; transactionHash: string } | null;
  validations: Array<{ timestamp: string | number; transactionHash: string }>;
};

/** Returns bridging time in seconds, or null if it cannot (yet) be determined. */
export function bridgingTimeSeconds(tx: Row): number | null {
  const start = Number(tx.timestamp);
  if (!start) return null;

  if (tx.initiatorNetwork === 1) {
    // ETH -> GC: UserRequestForAffirmation -> AffirmationCompleted
    if (!tx.execution) return null;
    // Row was created by AffirmationCompleted itself (start event not indexed), so it has no real start
    if (
      tx.transactionHash &&
      tx.transactionHash === tx.execution.transactionHash
    )
      return null;
    const end = Number(tx.execution.timestamp);
    return end >= start ? end - start : null;
  }

  if (tx.initiatorNetwork === 100) {
    // GC -> ETH: UserRequestForSignature -> CollectedSignatures (= last SignedForUserRequest)
    if (!["UNCLAIMED", "COMPLETED", "ERROR"].includes(tx.transactionStatus))
      return null;
    if (!tx.validations?.length) return null;
    const end = Math.max(...tx.validations.map((v) => Number(v.timestamp)));
    return end >= start ? end - start : null;
  }

  return null;
}
```

Aggregate with median and p90/p95 rather than the mean, because outliers (validator downtime, ETH reorg waits) skew the mean heavily.
Group by `bridgeType` and by a time bucket of `Transaction.timestamp` (for example, per day) to compare periods, such as before
and after a validator or finality-rule change.

---

## 5. Pitfalls and edge cases

1. **Wrong end event for GC→ETH.** `execution` is the Ethereum claim. Use `max(validations.timestamp)` together with status
   `UNCLAIMED`, `COMPLETED` or `ERROR`.
2. **`COLLECTING` rows are in flight.** For GC→ETH, `max(validations)` on a `COLLECTING` row is only the latest
   partial signature. Exclude these rows, or treat them as censored or pending.
3. **Missing validations.** A `TransactionValidation` is stored only if the signer is a known validator (`getValidator` checks the
   `Validator` entity or `envio-indexer/src/seed/validators.json`). If the seed list is stale, a signature may be missing,
   and `max(validations)` could come from an earlier signer, which **underestimates** the time. For the AMB direction, a validation is stored only if the
   `Transaction` row already exists (OmniBridge flows only). If you need exact numbers, cross-check: the tx at
   `validations[max].transactionHash` on Gnosis should contain a `CollectedSignatures` log.
4. **xDAI ETH→GC execution can be dropped.** `XDAIHome.AffirmationCompleted` returns early without writing an execution
   if `tx.from` is not a known xDAI validator, so the row stays `COLLECTING`. Treat it as missing data, not as a slow bridge.
5. **AMB rows created at the destination.** If the source event predates the indexer start blocks
   (Gnosis `39568341`, Ethereum `22272590`), `AMBHome.AffirmationCompleted` / `AMBForeign.RelayedMessage` may create the
   `Transaction` themselves with `timestamp` = execution time. Those rows give a duration of 0. Exclude them with
   `transactionHash === execution.transactionHash` or `timestamp === execution.timestamp`.
6. **Only OmniBridge token messages are indexed for AMB.** Arbitrary AMB messages that are not OmniBridge are filtered out by
   `isOmniBridgeUsage(encodedData)`.
7. **xDAI ETH→GC requires a DAI/USDS `Transfer` in the same tx.** Without one, the handler returns early and no row is created.
8. **Cross-chain clocks.** ETH→GC subtracts an Ethereum block timestamp from a Gnosis block timestamp. Both are Unix seconds, but the
   granularity is ~12 s (ETH) and ~5 s (GC), so sub-block precision is meaningless.
9. **Direction comes from `initiatorNetwork`**, not from `bridgeType`. The app maps `gnosis2mainnet` → `initiatorNetwork = 100`
   and `mainnet2gnosis` → `initiatorNetwork = 1` (`app/src/utils/transactionsQuery.ts`).
10. **IDs differ by bridge.** To look up a known message, xDAI post-Hashi IDs are `0x{chainId as 8 hex}{last 28 bytes of nonce}`
    (`envio-indexer/src/utils/combineNonceAndChainId.ts`), where chainId is the **source** chain (1 for ETH→GC, 100 for GC→ETH).
    AMB IDs are the raw `messageId`. You can also filter by the source `transactionHash` (lowercase).
11. **Proxy allow-list.** Through `/api/graphql`, only the exact `ENVIO_TRANSACTIONS_QUERY` text works. Change only variables.
    Any other query returns HTTP 403.

---

## 6. Contract / event quick reference

| Chain        | Contract           | Address                                      | Events used for timing                                                                                                                        |
| ------------ | ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Ethereum (1) | xDAI ForeignBridge | `0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016` | `UserRequestForAffirmation` (start, ETH→GC)                                                                                                   |
| Ethereum (1) | AMB Foreign        | `0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e` | `UserRequestForAffirmation` (start, ETH→GC)                                                                                                   |
| Gnosis (100) | xDAI HomeBridge    | `0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6` | `AffirmationCompleted` (end, ETH→GC); `UserRequestForSignature` (start, GC→ETH); `SignedForUserRequest` + `CollectedSignatures` (end, GC→ETH) |
| Gnosis (100) | AMB Home           | `0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59` | same as the xDAI HomeBridge row                                                                                                               |
