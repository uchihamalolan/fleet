// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Reading, StatusBadge } from '../src/ui/components/Badges';
import { MIN, T0 } from './helpers';

describe('badges convey state in text, not colour alone', () => {
  it('labels stale readings', () => {
    render(<Reading signal="soc" view={{ value: 12, eventTs: T0 - 30 * MIN, receivedTs: T0, freshness: 'stale' }} now={T0} />);
    expect(screen.getByText('12%')).toBeInTheDocument();
    expect(screen.getByText(/stale · 30m ago/)).toBeInTheDocument();
  });
  it('labels missing readings', () => {
    render(<Reading signal="battery_temp_c" view={undefined} now={T0} />);
    expect(screen.getByText('no data')).toBeInTheDocument();
  });
  it('status badges have text', () => {
    render(<StatusBadge status="unverified" />);
    expect(screen.getByText("Can't verify")).toBeInTheDocument();
  });
});
