import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';

export default function Home(): React.JSX.Element {
  return (
    <Layout title="Developer Portal" description="Mobile Money partner API docs">
      <main style={{ padding: '4rem 1.5rem', maxWidth: 900, margin: '0 auto' }}>
        <h1>Mobile Money API Documentation Portal</h1>
        <p>
          This portal publishes a searchable, first-class API reference for partners using the
          canonical <code>openapi.yaml</code> in this repository.
        </p>
        <p style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          <Link className="button button--primary button--lg" to="/api">
            Open API Reference
          </Link>
          <Link className="button button--secondary button--lg" to="/graphql">
            GraphQL Playground
          </Link>
        </p>
      </main>
    </Layout>
  );
}
