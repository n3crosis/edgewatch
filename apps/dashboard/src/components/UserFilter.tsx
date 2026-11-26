import { InputGroup } from '@cloudflare/kumo/components/input-group';
import { UserIcon, XIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

const DEBOUNCE_MS = 180;

export default function UserFilter({ className = 'w-full sm:w-48' }: { className?: string }) {
  const [params, setParams] = useSearchParams();
  const value = params.get('user') ?? '';
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const applyUser = (nextValue: string) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (nextValue) next.set('user', nextValue); else next.delete('user');
      for (const key of ['cursor', 'offset', 'entry']) next.delete(key);
      return next;
    });
  };

  const commit = (nextValue: string, immediate = false) => {
    setDraft(nextValue);
    if (timer.current) clearTimeout(timer.current);
    if (immediate) applyUser(nextValue);
    else timer.current = setTimeout(() => applyUser(nextValue), DEBOUNCE_MS);
  };

  return (
    <InputGroup className={className}>
      <InputGroup.Addon align="start">
        <UserIcon className="text-kumo-subtle" />
      </InputGroup.Addon>
      <InputGroup.Input
        type="text"
        value={draft}
        onChange={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit(draft, true);
          else if (event.key === 'Escape' && draft) commit('', true);
        }}
        placeholder="User ID…"
        aria-label="User ID"
      />
      {draft && (
        <InputGroup.Addon align="end">
          <button
            type="button"
            onClick={() => commit('', true)}
            aria-label="Clear user filter"
            className="grid size-5 place-items-center rounded text-kumo-subtle transition-colors hover:text-kumo-strong"
          >
            <XIcon size={12} />
          </button>
        </InputGroup.Addon>
      )}
    </InputGroup>
  );
}
