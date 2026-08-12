import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';

describe('<Button />', () => {
  it('renders its label', () => {
    render(<Button>New Reservation</Button>);
    expect(screen.getByRole('button', { name: 'New Reservation' })).toBeInTheDocument();
  });

  it('defaults to type="button" so it cannot accidentally submit a form', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'button');
  });

  it('calls its handler on click', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('blocks interaction while loading — the guard against duplicate writes', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Record Payment
      </Button>,
    );

    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('does not fire when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    await userEvent.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is not marked busy when idle', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-busy');
  });
});
