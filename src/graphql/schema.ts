import { gql } from "apollo-server-express";

export const typeDefs = gql`
  type User {
    id: ID!
    subject: String!
  }

  type Transaction {
    id: ID!
    referenceNumber: String!
    type: String!
    amount: String!
    phoneNumber: String!
    provider: String!
    stellarAddress: String!
    status: String!
    tags: [String!]!
    retryCount: Int
    createdAt: String!
    jobProgress: Float
  }

  type DepositResult {
    transactionId: ID!
    referenceNumber: String!
    status: String!
    jobId: String!
  }

  type WithdrawResult {
    transactionId: ID!
    referenceNumber: String!
    status: String!
    jobId: String!
  }

  type DisputeNote {
    id: ID!
    disputeId: ID!
    author: String!
    note: String!
    createdAt: String!
  }

  type Dispute {
    id: ID!
    transactionId: ID!
    reason: String!
    status: String!
    assignedTo: String
    resolution: String
    reportedBy: String
    createdAt: String!
    updatedAt: String!
    notes: [DisputeNote!]!
  }

  type DisputeReportSummaryRow {
    status: String!
    count: String!
    avgResolutionHours: String
  }

  type DisputeReportTotals {
    total: Int!
    open: Int!
    investigating: Int!
    resolved: Int!
    rejected: Int!
  }

  type DisputeReport {
    generatedAt: String!
    summary: [DisputeReportSummaryRow!]!
    totals: DisputeReportTotals!
  }

  type BulkImportJobProgress {
    total: Int!
    processed: Int!
    succeeded: Int!
    failed: Int!
  }

  type BulkImportJobError {
    row: Int!
    error: String!
  }

  type BulkImportJob {
    jobId: ID!
    status: String!
    progress: BulkImportJobProgress!
    errors: [BulkImportJobError!]!
    createdAt: String!
    completedAt: String
  }

  # Subscription types for real-time updates
  type Subscription {
    # Subscribe to transaction events
    transactionCreated: Transaction!
    transactionUpdated(id: ID): Transaction!
    transactionCompleted: Transaction!
    transactionFailed: Transaction!
    
    # Subscribe to dispute events
    disputeCreated: Dispute!
    disputeUpdated(id: ID): Dispute!
    disputeNoteAdded(disputeId: ID): DisputeNote!
    
    # Subscribe to bulk import job events
    bulkImportJobUpdated(jobId: ID!): BulkImportJob!
  }

  input DepositInput {
    amount: String!
    phoneNumber: String!
    provider: String!
    stellarAddress: String!
  }

  input WithdrawInput {
    amount: String!
    phoneNumber: String!
    provider: String!
    stellarAddress: String!
  }

  input OpenDisputeInput {
    transactionId: ID!
    reason: String!
    reportedBy: String
  }

  input UpdateDisputeStatusInput {
    disputeId: ID!
    status: String!
    resolution: String
    assignedTo: String
  }

  input AssignDisputeInput {
    disputeId: ID!
    agentName: String!
  }

  input AddDisputeNoteInput {
    disputeId: ID!
    author: String!
    note: String!
  }

  input DisputeReportFilterInput {
    from: String
    to: String
    assignedTo: String
  }

  type Query {
    me: User
    transaction(id: ID!): Transaction
    transactions(limit: Int, offset: Int): [Transaction!]!
    transactionByReferenceNumber(referenceNumber: String!): Transaction
    transactionsByTags(tags: [String!]!): [Transaction!]!
    dispute(id: ID!): Dispute
    disputeReport(filter: DisputeReportFilterInput): DisputeReport!
    bulkImportJob(id: ID!): BulkImportJob
  }

  type Mutation {
    deposit(input: DepositInput!): DepositResult!
    withdraw(input: WithdrawInput!): WithdrawResult!
    openDispute(input: OpenDisputeInput!): Dispute!
    updateDisputeStatus(input: UpdateDisputeStatusInput!): Dispute!
    assignDispute(input: AssignDisputeInput!): Dispute!
    addDisputeNote(input: AddDisputeNoteInput!): DisputeNote!
  }
`;
