import React from 'react';
import Layout from '@theme/Layout';
import BrowserOnly from '@docusaurus/BrowserOnly';

export default function GraphQLPage(): React.JSX.Element {
  return (
    <Layout
      title="GraphQL Playground"
      description="Interactive GraphQL Playground to explore and test the Mobile Money GraphQL API schema"
    >
      <BrowserOnly fallback={<p style={{ padding: '2rem' }}>Loading GraphQL Playground...</p>}>
        {() => {
          const GraphQLPlayground = require('../components/GraphQLPlayground').default;
          return <GraphQLPlayground />;
        }}
      </BrowserOnly>
    </Layout>
  );
}
