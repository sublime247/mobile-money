import React from 'react';
import { RedocStandalone } from 'redoc';
import Link from '@docusaurus/Link';
import styles from './ApiReference.module.css';

export default function ApiReference(): React.JSX.Element {
  return (
    <div>
      <div className={styles.sandboxBanner}>
        <p>
          Want to try the API interactively?{' '}
          <Link to="/sandbox" className={styles.sandboxLink}>
            Open API Sandbox →
          </Link>
        </p>
      </div>
      <RedocStandalone
        specUrl="/openapi.yaml"
        options={{
          hideHostname: false,
          disableSearch: false,
          expandResponses: '200,201',
          requiredPropsFirst: true,
          sortPropsAlphabetically: true,
        }}
      />
    </div>
  );
}