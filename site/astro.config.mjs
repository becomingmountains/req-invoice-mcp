import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://becomingmountains.github.io',
  base: '/req-invoice-mcp',
  integrations: [
    starlight({
      title: 'req-invoice-mcp',
      description: 'Crypto invoices for AI assistants, on Request Network.',
      logo: { src: './src/assets/logo.svg' },
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/becomingmountains/req-invoice-mcp' }],
      editLink: { baseUrl: 'https://github.com/becomingmountains/req-invoice-mcp/edit/main/site/' },
      customCss: ['./src/styles/theme.css'],
      lastUpdated: true,
      sidebar: [
        {
          label: 'Get started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'How it works', slug: 'how-it-works' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Get paid with a link', slug: 'guides/payment-links' },
            { label: 'Custom invoices', slug: 'guides/custom-invoices' },
            { label: "Track what you're owed", slug: 'guides/tracking' },
            { label: 'For payers', slug: 'guides/payers' },
            { label: 'Test on Sepolia', slug: 'guides/sepolia' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Tools', slug: 'reference/tools' },
            { label: 'Configuration', slug: 'reference/configuration' },
            { label: 'Errors', slug: 'reference/errors' },
          ],
        },
        {
          label: 'Resources',
          items: [
            { label: 'Security', slug: 'security' },
            { label: 'FAQ', slug: 'faq' },
          ],
        },
      ],
    }),
  ],
});
