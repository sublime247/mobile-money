import { config as dotenvConfig } from 'dotenv';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { themes as prismThemes } from 'prism-react-renderer';

// Load environment variables from .env (local development)
dotenvConfig({ path: './.env' });

const config: Config = {
  title: 'Mobile Money API Portal',
  tagline: 'Searchable API docs powered by OpenAPI + Redoc',
  favicon: 'img/logo.svg',

  future: {
    v4: true,
  },

  url: 'https://sublime247.github.io',
  baseUrl: '/mobile-money/',

  organizationName: 'sublime247',
  projectName: 'mobile-money',

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'fr'],
  },

  presets: [
    [
      'classic',
      {
        docs: false,
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // -------------------------------------------------------------------------
    // Algolia DocSearch – full-text search for the docs portal
    // -------------------------------------------------------------------------
    // The free DocSearch program is available for open‑source projects.
    // 1. Apply at https://docsearch.algolia.com/apply
    // 2. Set the three environment variables below once approved.
    // -------------------------------------------------------------------------
    ...(process.env.ALGOLIA_APP_ID &&
      process.env.ALGOLIA_API_KEY &&
      process.env.ALGOLIA_INDEX_NAME && {
        algolia: {
          appId: process.env.ALGOLIA_APP_ID,
          apiKey: process.env.ALGOLIA_API_KEY,
          indexName: process.env.ALGOLIA_INDEX_NAME,
          contextualSearch: true,
        },
      }),

    navbar: {
      title: 'Mobile Money API',
      items: [
        { to: '/', label: 'Overview', position: 'left' },
        { to: '/api', label: 'Reference', position: 'left' },
        { to: '/graphql', label: 'GraphQL Playground', position: 'left' },
        {
          href: 'https://github.com/sublime247/mobile-money',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'API Reference', to: '/api' },
            { label: 'GraphQL Playground', to: '/graphql' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Mobile Money`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'typescript', 'python'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;