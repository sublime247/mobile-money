import { makeExecutableSchema } from "@graphql-tools/schema";
import {
  validate,
  parse,
  GraphQLError,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLList,
  GraphQLInt,
} from "graphql";
import depthLimit from "graphql-depth-limit";
import {
  createComplexityRule,
  simpleEstimator,
  fieldExtensionsEstimator,
} from "graphql-query-complexity";

const typeDefs = `
  type User {
    id: ID!
    name: String!
    friends: [User!]!
  }

  type Transaction {
    id: ID!
    amount: String!
    status: String!
    dispute: Dispute
  }

  type Dispute {
    id: ID!
    reason: String!
    notes: [DisputeNote!]!
  }

  type DisputeNote {
    id: ID!
    note: String!
    author: String!
  }

  type Query {
    me: User
    transaction(id: ID!): Transaction
    transactions(limit: Int, offset: Int): [Transaction!]!
  }
`;

const resolvers = {
  Query: {
    me: () => ({ id: "1", name: "Test" }),
    transaction: () => null,
    transactions: () => [],
  },
};

function runValidation(
  query: string,
  rules: any[],
): readonly GraphQLError[] {
  const schema = makeExecutableSchema({ typeDefs, resolvers });
  const document = parse(query);
  return validate(schema, document, rules);
}

describe("GraphQL Depth Limit", () => {
  it("should allow queries within the depth limit of 5", () => {
    const query = `
      query GetDeep {
        transaction(id: "1") {
          id
          dispute {
            id
            notes {
              id
              note
            }
          }
        }
      }
    `;

    const errors = runValidation(query, [depthLimit(5)]);
    expect(errors).toHaveLength(0);
  });

  it("should reject queries deeper than 5 levels", () => {
    const query = `
      query TooDeep {
        me {
          friends {
            friends {
              friends {
                friends {
                  friends {
                    id
                  }
                }
              }
            }
          }
        }
      }
    `;

    const errors = runValidation(query, [depthLimit(5)]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("exceeds maximum operation depth of 5");
  });

  it("should reject a query at exactly depth 6", () => {
    const query = `
      query SixLevels {
        me {
          friends {
            friends {
              friends {
                friends {
                  friends {
                    name
                  }
                }
              }
            }
          }
        }
      }
    `;

    const errors = runValidation(query, [depthLimit(5)]);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("should allow a query at exactly depth 5", () => {
    const query = `
      query FiveLevels {
        me {
          friends {
            friends {
              friends {
                friends {
                  name
                }
              }
            }
          }
        }
      }
    `;

    const errors = runValidation(query, [depthLimit(5)]);
    expect(errors).toHaveLength(0);
  });
});

describe("GraphQL Query Complexity", () => {
  it("should allow queries within the maximum complexity", () => {
    const query = `
      query Simple {
        me {
          id
          name
        }
      }
    `;

    const errors = runValidation(query, [
      createComplexityRule({
        maximumComplexity: 500,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
      }),
    ]);
    expect(errors).toHaveLength(0);
  });

  it("should reject overly complex queries", () => {
    const query = `
      query Complex {
        me {
          friends {
            friends {
              friends {
                friends {
                  friends {
                    friends {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const errors = runValidation(query, [
      createComplexityRule({
        maximumComplexity: 10,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
      }),
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain("too complex");
  });

  it("should reject queries exceeding max query nodes", () => {
    const query = `
      query ManyNodes {
        me {
          id
          name
          friends {
            id
            name
          }
        }
      }
    `;

    const errors = runValidation(query, [
      createComplexityRule({
        maximumComplexity: 10000,
        maxQueryNodes: 2,
        estimators: [
          fieldExtensionsEstimator(),
          simpleEstimator({ defaultComplexity: 1 }),
        ],
      }),
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("Combined Depth and Complexity Rules", () => {
  const validationRules = [
    depthLimit(5),
    createComplexityRule({
      maximumComplexity: 1000,
      estimators: [
        fieldExtensionsEstimator(),
        simpleEstimator({ defaultComplexity: 1 }),
      ],
    }),
  ];

  it("should allow a valid query", () => {
    const query = `
      query Valid {
        transaction(id: "1") {
          id
          amount
          status
          dispute {
            id
            reason
          }
        }
      }
    `;

    const errors = runValidation(query, validationRules);
    expect(errors).toHaveLength(0);
  });

  it("should reject a query that violates both depth and complexity", () => {
    const query = `
      query Bad {
        me {
          friends {
            friends {
              friends {
                friends {
                  friends {
                    friends {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const errors = runValidation(query, validationRules);
    expect(errors.length).toBeGreaterThan(0);
  });
});
