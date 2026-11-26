import { Button } from '@cloudflare/kumo/components/button';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { Component, type ReactNode } from 'react';

/** Keep navigation available if a page fails to render or its deployment chunk cannot load. */
export default class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <LayerCard role="alert" className="mx-auto my-8 max-w-lg p-6">
        <div className="flex items-start gap-3">
          <WarningCircleIcon size={20} className="mt-0.5 shrink-0 text-kumo-danger" />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-kumo-strong">This page couldn’t load</h2>
            <p className="mt-1.5 text-sm text-kumo-subtle">
              Reload to try again. If the problem continues, check your connection or open another page from the menu.
            </p>
            <Button variant="secondary" size="sm" icon={ArrowClockwiseIcon} className="mt-4" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          </div>
        </div>
      </LayerCard>
    );
  }
}
