# GraphQL API

The service exposes a GraphQL endpoint alongside the REST API for flexible reads and writes.

- **Endpoint:** `POST /graphql` (and `GET /graphql` for the IDE in development)
- **IDE:** [GraphQL Playground](https://github.com/graphql/graphql-playground) is served at `/graphql` when `NODE_ENV` is not `production`.

## Authentication

1. **Production:** Set `GRAPHQL_API_KEY` in the environment. Every GraphQL request must send that value using either:
   - Header `x-api-key: <your-key>`, or
   - Header `Authorization: Bearer <your-key>`
2. **Development:** If `GRAPHQL_API_KEY` is unset, requests are allowed without a key (for local use and Playground). If you set `GRAPHQL_API_KEY` locally, the same headers apply.
3. Optional: `GRAPHQL_CLIENT_SUBJECT` — label returned by the `me` query when authenticated (default `api-client`).

The `me` query returns `null` when no API key is configured (anonymous development mode). When a valid key is sent, `me` returns `{ id, subject }`.

## Schema overview

Core types include `Transaction`, `Dispute`, `DisputeNote`, `DisputeReport`, `BulkImportJob`, and `User`. Mutations mirror REST flows: deposits/withdrawals, opening and managing disputes, and notes.

Introspection is available in development via Playground (`Docs` / `Schema` panels).

## Example: introspection (development)

Open `http://localhost:3000/graphql` in a browser and run:

```graphql
query {
  __schema {
    queryType {
      fields {
        name
      }
    }
  }
}
```

## Example: authenticated health read

With `GRAPHQL_API_KEY=my-secret-key`:

```graphql
query {
  me {
    id
    subject
  }
}
```

HTTP headers:

```http
x-api-key: my-secret-key
```

## Example: transaction by id

```graphql
query GetTxn($id: ID!) {
  transaction(id: $id) {
    id
    referenceNumber
    amount
    status
    createdAt
    tags
    jobProgress
  }
}
```

Variables:

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

## Example: list transactions

```graphql
query List {
  transactions(limit: 10, offset: 0) {
    id
    referenceNumber
    type
    status
    createdAt
  }
}
```

## Example: deposit mutation

```graphql
mutation Deposit {
  deposit(
    input: {
      amount: "100.00"
      phoneNumber: "+237670000000"
      provider: "mtn"
      stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    }
  ) {
    transactionId
    referenceNumber
    status
    jobId
  }
}
```

## Example: open dispute and fetch with notes

```graphql
mutation Open {
  openDispute(
    input: {
      transactionId: "550e8400-e29b-41d4-a716-446655440000"
      reason: "Amount not credited"
      reportedBy: "user-42"
    }
  ) {
    id
    status
    transactionId
  }
}

query OneDispute($id: ID!) {
  dispute(id: $id) {
    id
    status
    notes {
      author
      note
      createdAt
    }
  }
}
```

## Example: dispute report

```graphql
query Report {
  disputeReport(
    filter: { from: "2026-01-01T00:00:00.000Z", assignedTo: "agent-1" }
  ) {
    generatedAt
    totals {
      total
      open
      resolved
    }
    summary {
      status
      count
      avgResolutionHours
    }
  }
}
```

## Example: bulk import job status

After creating a job via `POST /api/transactions/bulk`, poll with:

```graphql
query Bulk($id: ID!) {
  bulkImportJob(id: $id) {
    status
    progress {
      total
      processed
      succeeded
      failed
    }
    errors {
      row
      error
    }
    createdAt
    completedAt
  }
}
```

## cURL

```bash
curl -s -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"query":"query { me { subject } }"}'
```

## Error codes (extensions)

GraphQL responses use `errors[].extensions.code` where applicable, for example:

| Code              | Typical case                      |
| ----------------- | --------------------------------- |
| `UNAUTHENTICATED` | Missing or invalid API key        |
| `NOT_FOUND`       | Resource missing                  |
| `CONFLICT`        | Duplicate dispute or deposit lock |
| `BAD_USER_INPUT`  | Validation / invalid transition   |
| `INTERNAL`        | Unexpected failure                |

## REST parity

| REST                                                                     | GraphQL                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `GET /api/transactions/:id`                                              | `transaction`, `transactions`, `transactionByReferenceNumber`, `transactionsByTags`                 |
| `POST .../deposit`                                                       | `deposit`                                                                                           |
| `POST .../withdraw`                                                      | `withdraw`                                                                                          |
| Dispute routes under `/api/disputes` and `/api/transactions/:id/dispute` | `dispute`, `disputeReport`, `openDispute`, `updateDisputeStatus`, `assignDispute`, `addDisputeNote` |
| `GET /api/transactions/bulk/:jobId`                                      | `bulkImportJob`                                                                                     |

CSV bulk **upload** remains `POST /api/transactions/bulk` (multipart); GraphQL is used to query job status by id.
