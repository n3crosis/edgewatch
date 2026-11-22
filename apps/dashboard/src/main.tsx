import { TooltipProvider } from '@cloudflare/kumo/components/tooltip';
import { LinkProvider } from '@cloudflare/kumo/utils';
import { StrictMode, forwardRef } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, type LinkProps } from 'react-router-dom';
import App from './App';
import './index.css';

/** Lets Kumo's LinkButton/Link navigate with react-router instead of full page loads. */
const RouterLink = forwardRef<HTMLAnchorElement, Omit<LinkProps, 'to'> & { href?: string; to?: string }>(({ href, to, ...props }, ref) => (
  <Link ref={ref} to={to ?? href ?? '#'} {...props} />
));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <LinkProvider component={RouterLink}>
        <TooltipProvider delay={150}>
          <App />
        </TooltipProvider>
      </LinkProvider>
    </BrowserRouter>
  </StrictMode>,
);
